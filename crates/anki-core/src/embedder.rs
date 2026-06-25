//! ONNX sentence embedding via Tract.
//!
//! The model is **not** bundled. It is loaded at runtime from bytes handed in by
//! the JS glue (see `docs/dynamic-model-loading.md`) via [`Embedder::load`]. The
//! embedding dimension is a property of the loaded model, not a constant.

use crate::error::AnkiError;
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use std::sync::Arc;
use tokenizers::Tokenizer;
use tract_core::prelude::*;
use tract_onnx::prelude::*;

static EMBEDDER: OnceCell<Arc<Mutex<Embedder>>> = OnceCell::new();

/// Sentence embedder backed by a runtime-loaded ONNX model and HF tokenizer.
pub struct Embedder {
    model: SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>,
    tokenizer: Tokenizer,
    /// Output embedding dimension for the loaded model.
    dim: usize,
}

impl Embedder {
    /// Returns the loaded shared embedder.
    ///
    /// # Errors
    ///
    /// Returns [`AnkiError::Inference`] if no model has been loaded yet (the JS
    /// glue must call `anki_load_model` before any embedding happens).
    pub fn global() -> Result<Arc<Mutex<Embedder>>, AnkiError> {
        EMBEDDER
            .get()
            .cloned()
            .ok_or_else(|| AnkiError::Inference("no model loaded".into()))
    }

    /// Loads the global embedder from ONNX + tokenizer bytes. First load wins;
    /// a second call is rejected (one model per module instance for now).
    ///
    /// # Errors
    ///
    /// Returns [`AnkiError::Inference`] on parse failure or if already loaded.
    pub fn load(model_onnx: &[u8], tokenizer_json: &str, dim: usize) -> Result<(), AnkiError> {
        let embedder = Self::from_bytes(model_onnx, tokenizer_json, dim)?;
        EMBEDDER
            .set(Arc::new(Mutex::new(embedder)))
            .map_err(|_| AnkiError::Inference("model already loaded".into()))
    }

    /// Returns the embedding dimension of the loaded model.
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Builds an embedder from ONNX + tokenizer bytes for a model of dimension `dim`.
    ///
    /// # Errors
    ///
    /// Returns [`AnkiError::Inference`] on parse or runtime failures.
    pub fn from_bytes(
        model_onnx: &[u8],
        tokenizer_json: &str,
        dim: usize,
    ) -> Result<Self, AnkiError> {
        let tokenizer = Tokenizer::from_bytes(tokenizer_json.as_bytes())
            .map_err(|e| AnkiError::Inference(format!("tokenizer: {e}")))?;

        let model = tract_onnx::onnx()
            .model_for_read(&mut std::io::Cursor::new(model_onnx))
            .map_err(|e| AnkiError::Inference(format!("onnx parse: {e}")))?
            .into_optimized()
            .map_err(|e| AnkiError::Inference(format!("onnx optimize: {e}")))?
            .into_runnable()
            .map_err(|e| AnkiError::Inference(format!("onnx runnable: {e}")))?;

        Ok(Self {
            model,
            tokenizer,
            dim,
        })
    }

    /// Embeds `text` into a fixed-size `f32` vector (length [`Embedder::dim`]).
    ///
    /// # Errors
    ///
    /// Returns [`AnkiError::EmptyInput`] for null/empty/whitespace-only text.
    /// Returns [`AnkiError::Inference`] when tokenization or ONNX fails.
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, AnkiError> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(AnkiError::EmptyInput);
        }

        let encoding = self
            .tokenizer
            .encode(trimmed, true)
            .map_err(|e| AnkiError::Inference(format!("tokenize: {e}")))?;

        let input_ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
        let attention_mask: Vec<i64> = encoding
            .get_attention_mask()
            .iter()
            .map(|&m| m as i64)
            .collect();
        let token_type_ids: Vec<i64> = encoding
            .get_type_ids()
            .iter()
            .map(|&t| t as i64)
            .collect();

        let batch = 1usize;
        let len = input_ids.len();

        let input_ids_t = tract_ndarray::Array2::from_shape_vec((batch, len), input_ids)
            .map_err(|e| AnkiError::Inference(format!("input_ids shape: {e}")))?
            .into_dyn();
        let mask_t = tract_ndarray::Array2::from_shape_vec((batch, len), attention_mask)
            .map_err(|e| AnkiError::Inference(format!("mask shape: {e}")))?
            .into_dyn();
        let type_t = tract_ndarray::Array2::from_shape_vec((batch, len), token_type_ids)
            .map_err(|e| AnkiError::Inference(format!("type_ids shape: {e}")))?
            .into_dyn();

        let outputs = self
            .model
            .run(tvec!(
                Tensor::from(input_ids_t).into(),
                Tensor::from(mask_t).into(),
                Tensor::from(type_t).into()
            ))
            .map_err(|e| AnkiError::Inference(format!("onnx run: {e}")))?;

        let tensor = outputs[0]
            .to_array_view::<f32>()
            .map_err(|e| AnkiError::Inference(format!("output view: {e}")))?;

        let shape: Vec<usize> = tensor.shape().to_vec();
        let slice = tensor
            .as_slice()
            .ok_or_else(|| AnkiError::Inference("non-contiguous ONNX output".into()))?;

        // Sentence-transformer ONNX outputs token embeddings [1, seq, dim]; the
        // sentence embedding is the mean over tokens (no padding for a single
        // input, so a plain mean equals masked mean pooling). Some exports
        // already pool to [1, dim].
        let dim = self.dim;
        let pooled: Vec<f32> = match shape.as_slice() {
            [_, seq, hid] if *hid == dim => {
                let (seq, hid) = (*seq, *hid);
                let mut v = vec![0f32; hid];
                for t in 0..seq {
                    let base = t * hid;
                    for h in 0..hid {
                        v[h] += slice[base + h];
                    }
                }
                let denom = seq.max(1) as f32;
                for x in &mut v {
                    *x /= denom;
                }
                v
            }
            [_, hid] if *hid == dim => slice[..dim].to_vec(),
            _ if slice.len() == dim => slice.to_vec(),
            _ => {
                return Err(AnkiError::Inference(format!(
                    "unexpected ONNX output shape {shape:?} for dim {dim}"
                )))
            }
        };

        Ok(normalize_l2(&pooled))
    }
}

/// L2-normalizes `v` in place conceptually; returns a new normalized vector.
fn normalize_l2(v: &[f32]) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm <= f32::EPSILON {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_unit_length() {
        let v = normalize_l2(&[3.0, 4.0]);
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }
}
