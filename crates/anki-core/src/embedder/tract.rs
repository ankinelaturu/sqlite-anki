//! Tract ONNX inference engine (default). Parses + optimizes the model once at
//! load; `run` executes the compiled plan per embedding.

use crate::error::AnkiError;
use tract_core::prelude::*;
use tract_onnx::prelude::*;

pub struct Engine {
    model: SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>,
}

impl Engine {
    pub fn load(model_onnx: &[u8], _dim: usize) -> Result<Self, AnkiError> {
        let model = tract_onnx::onnx()
            .model_for_read(&mut std::io::Cursor::new(model_onnx))
            .map_err(|e| AnkiError::Inference(format!("onnx parse: {e}")))?
            .into_optimized()
            .map_err(|e| AnkiError::Inference(format!("onnx optimize: {e}")))?
            .into_runnable()
            .map_err(|e| AnkiError::Inference(format!("onnx runnable: {e}")))?;
        Ok(Self { model })
    }

    pub fn run(
        &self,
        input_ids: &[i64],
        attention_mask: &[i64],
        token_type_ids: &[i64],
    ) -> Result<(Vec<f32>, Vec<usize>), AnkiError> {
        let batch = 1usize;
        let len = input_ids.len();

        let ids = tract_ndarray::Array2::from_shape_vec((batch, len), input_ids.to_vec())
            .map_err(|e| AnkiError::Inference(format!("input_ids shape: {e}")))?
            .into_dyn();
        let mask = tract_ndarray::Array2::from_shape_vec((batch, len), attention_mask.to_vec())
            .map_err(|e| AnkiError::Inference(format!("mask shape: {e}")))?
            .into_dyn();
        let types = tract_ndarray::Array2::from_shape_vec((batch, len), token_type_ids.to_vec())
            .map_err(|e| AnkiError::Inference(format!("type_ids shape: {e}")))?
            .into_dyn();

        let outputs = self
            .model
            .run(tvec!(
                Tensor::from(ids).into(),
                Tensor::from(mask).into(),
                Tensor::from(types).into()
            ))
            .map_err(|e| AnkiError::Inference(format!("onnx run: {e}")))?;

        let tensor = outputs[0]
            .to_array_view::<f32>()
            .map_err(|e| AnkiError::Inference(format!("output view: {e}")))?;
        let shape = tensor.shape().to_vec();
        let data = tensor
            .as_slice()
            .ok_or_else(|| AnkiError::Inference("non-contiguous ONNX output".into()))?
            .to_vec();
        Ok((data, shape))
    }
}
