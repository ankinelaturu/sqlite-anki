//! ONNX sentence embedding via Tract.

use crate::error::AnkiError;
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use std::sync::Arc;
use tokenizers::Tokenizer;
use tract_core::prelude::*;
use tract_onnx::prelude::*;

/// Embedding dimension for the default `all-MiniLM-L6-v2` model.
pub const EMBED_DIM: usize = 384;

/// Logical model identifier baked into this build.
pub const MODEL_ID: &str = "all-MiniLM-L6-v2";

static EMBEDDER: OnceCell<Arc<Mutex<Embedder>>> = OnceCell::new();

/// Sentence embedder backed by a bundled ONNX model and HuggingFace tokenizer.
pub struct Embedder {
    model: SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>,
    tokenizer: Tokenizer,
}

impl Embedder {
    /// Returns the shared embedder, initializing from bundled bytes on first use.
    ///
    /// # Errors
    ///
    /// Returns [`AnkiError::Inference`] when the model fails to load or run.
    pub fn global() -> Result<Arc<Mutex<Embedder>>, AnkiError> {
        EMBEDDER
            .get_or_try_init(|| {
                let inner = Self::from_embedded()?;
                Ok(Arc::new(Mutex::new(inner)))
            })
            .map(Arc::clone)
    }

    /// Loads the embedder from ONNX + tokenizer bytes.
    ///
    /// # Errors
    ///
    /// Returns [`AnkiError::Inference`] on parse or runtime failures.
    pub fn from_bytes(model_onnx: &[u8], tokenizer_json: &str) -> Result<Self, AnkiError> {
        let tokenizer = Tokenizer::from_bytes(tokenizer_json.as_bytes())
            .map_err(|e| AnkiError::Inference(format!("tokenizer: {e}")))?;

        let model = tract_onnx::onnx()
            .model_for_read(&mut std::io::Cursor::new(model_onnx))
            .map_err(|e| AnkiError::Inference(format!("onnx parse: {e}")))?
            .into_optimized()
            .map_err(|e| AnkiError::Inference(format!("onnx optimize: {e}")))?
            .into_runnable()
            .map_err(|e| AnkiError::Inference(format!("onnx runnable: {e}")))?;

        Ok(Self { model, tokenizer })
    }

    #[cfg(embedded_model)]
    fn from_embedded() -> Result<Self, AnkiError> {
        const MODEL: &[u8] = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../models/all-MiniLM-L6-v2/model.onnx"
        ));
        const TOKENIZER: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../models/all-MiniLM-L6-v2/tokenizer.json"
        ));
        Self::from_bytes(MODEL, TOKENIZER)
    }

    #[cfg(not(embedded_model))]
    fn from_embedded() -> Result<Self, AnkiError> {
        Err(AnkiError::Inference(
            "embedded model missing — run scripts/download-model.sh".into(),
        ))
    }

    /// Embeds `text` into a fixed-size `f32` vector (length [`EMBED_DIM`]).
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

        // all-MiniLM ONNX outputs token embeddings [1, seq, 384]; the sentence
        // embedding is the mean over tokens (no padding for a single input, so a
        // plain mean equals masked mean pooling). Some exports already pool to
        // [1, 384].
        let pooled: Vec<f32> = match shape.as_slice() {
            [_, seq, hid] if *hid == EMBED_DIM => {
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
            [_, hid] if *hid == EMBED_DIM => slice[..EMBED_DIM].to_vec(),
            _ if slice.len() == EMBED_DIM => slice.to_vec(),
            _ => {
                return Err(AnkiError::Inference(format!(
                    "unexpected ONNX output shape {shape:?}"
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
    #[cfg(embedded_model)]
    fn embed_produces_correct_dim() {
        let emb = Embedder::from_embedded().expect("model");
        let v = emb.embed("hello world").expect("embed");
        assert_eq!(v.len(), EMBED_DIM);
    }
}
