//! Candle ONNX inference engine (opt-in via `engine-candle`). Decodes the model
//! once at load; `run` evaluates it with candle-onnx's `simple_eval` (matmuls go
//! through the `gemm` kernels).

use crate::error::AnkiError;
use candle_core::{DType, Device, Tensor};
use candle_onnx::onnx::ModelProto;
use prost::Message;
use std::collections::{HashMap, HashSet};

/// Which model input a graph input name maps to.
enum Slot {
    Ids,
    Mask,
    Type,
}

pub struct Engine {
    model: ModelProto,
    /// Graph input name → which of our three tensors feeds it.
    inputs: Vec<(String, Slot)>,
    /// Graph output name to read the embedding from.
    output: String,
}

impl Engine {
    pub fn load(model_onnx: &[u8], _dim: usize) -> Result<Self, AnkiError> {
        let model = ModelProto::decode(model_onnx)
            .map_err(|e| AnkiError::Inference(format!("onnx decode: {e}")))?;
        let graph = model
            .graph
            .as_ref()
            .ok_or_else(|| AnkiError::Inference("onnx: no graph".into()))?;

        // Real inputs are graph inputs that are not also initializers (constants).
        let initializers: HashSet<&str> =
            graph.initializer.iter().map(|t| t.name.as_str()).collect();

        let mut inputs = Vec::new();
        for vi in &graph.input {
            if initializers.contains(vi.name.as_str()) {
                continue;
            }
            let lower = vi.name.to_lowercase();
            let slot = if lower.contains("mask") {
                Slot::Mask
            } else if lower.contains("type") {
                Slot::Type
            } else {
                Slot::Ids
            };
            inputs.push((vi.name.clone(), slot));
        }
        if inputs.is_empty() {
            return Err(AnkiError::Inference("onnx: no inputs".into()));
        }

        let output = graph
            .output
            .first()
            .map(|o| o.name.clone())
            .ok_or_else(|| AnkiError::Inference("onnx: no output".into()))?;

        Ok(Self {
            model,
            inputs,
            output,
        })
    }

    pub fn run(
        &self,
        input_ids: &[i64],
        attention_mask: &[i64],
        token_type_ids: &[i64],
    ) -> Result<(Vec<f32>, Vec<usize>), AnkiError> {
        let len = input_ids.len();
        let dev = Device::Cpu;
        let mk = |data: &[i64]| -> Result<Tensor, AnkiError> {
            Tensor::from_vec(data.to_vec(), (1, len), &dev)
                .map_err(|e| AnkiError::Inference(format!("candle tensor: {e}")))
        };

        let mut feeds: HashMap<String, Tensor> = HashMap::new();
        for (name, slot) in &self.inputs {
            let t = match slot {
                Slot::Ids => mk(input_ids)?,
                Slot::Mask => mk(attention_mask)?,
                Slot::Type => mk(token_type_ids)?,
            };
            feeds.insert(name.clone(), t);
        }

        let outputs = candle_onnx::simple_eval(&self.model, feeds)
            .map_err(|e| AnkiError::Inference(format!("candle eval: {e}")))?;

        let out = outputs.get(&self.output).ok_or_else(|| {
            AnkiError::Inference(format!("candle: missing output {}", self.output))
        })?;
        let out = out
            .to_dtype(DType::F32)
            .map_err(|e| AnkiError::Inference(format!("candle dtype: {e}")))?;
        let shape = out.dims().to_vec();
        let data = out
            .flatten_all()
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(|e| AnkiError::Inference(format!("candle output: {e}")))?;
        Ok((data, shape))
    }
}
