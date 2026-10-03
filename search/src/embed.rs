//! Local sentence embeddings with ONNX Runtime (the same runtime as the
//! Parakeet transcription engine). Nothing leaves the machine.

use anyhow::{anyhow, Context, Result};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::{Session, SessionInputValue};
use ort::value::Tensor;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};

pub struct ModelFile {
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

pub struct ModelSpec {
    /// Stored with every embedding; a different id re-embeds everything.
    pub id: &'static str,
    /// Folder under the models directory.
    pub dir: &'static str,
    pub files: &'static [ModelFile],
    pub onnx_file: &'static str,
    pub query_prefix: &'static str,
    pub passage_prefix: &'static str,
    pub max_tokens: usize,
    /// For an index too small for the standout statistics (see
    /// `store::standout_test`): the least cosine similarity to show a
    /// meaning-only match…
    pub min_similarity: f32,
    /// …and how far below the best match it may be.
    pub similarity_window: f32,
}

impl ModelSpec {
    pub fn download_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    pub fn is_installed(&self, dir: &Path) -> bool {
        self.files.iter().all(|f| dir.join(f.name).metadata().map_or(false, |m| m.len() == f.size))
    }
}

/// multilingual-e5-small, int8: 384 dimensions, ~100 languages (Riff
/// transcribes many), 118 MB. Pinned to a revision and checked by SHA-256.
pub const DEFAULT_MODEL: ModelSpec = ModelSpec {
    id: "multilingual-e5-small-int8",
    dir: "multilingual-e5-small",
    files: &[
        ModelFile {
            name: "model_quantized.onnx",
            url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/onnx/model_quantized.onnx",
            sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
            size: 118_308_185,
        },
        ModelFile {
            name: "tokenizer.json",
            url: "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer.json",
            sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
            size: 17_082_730,
        },
    ],
    onnx_file: "model_quantized.onnx",
    query_prefix: "query: ",
    passage_prefix: "passage: ",
    max_tokens: 512,
    min_similarity: 0.80,
    similarity_window: 0.06,
};

pub fn verify_sha256(path: &Path, expected: &str) -> Result<bool> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok(actual == expected)
}

pub struct Embedder {
    pub spec: &'static ModelSpec,
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    input_names: Vec<String>,
}

impl Embedder {
    pub fn load(dir: &Path, spec: &'static ModelSpec) -> Result<Self> {
        if !spec.is_installed(dir) {
            return Err(anyhow!("embedding model {} is not installed in {}", spec.id, dir.display()));
        }
        let mut tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| anyhow!("tokenizer: {e}"))?;
        tokenizer
            .with_truncation(Some(TruncationParams { max_length: spec.max_tokens, ..Default::default() }))
            .map_err(|e| anyhow!("tokenizer: {e}"))?;
        tokenizer.with_padding(Some(PaddingParams { strategy: PaddingStrategy::BatchLongest, ..Default::default() }));

        // Few threads: indexing runs in the background, often while recording.
        let threads = std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(1, 4));
        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(threads)?
            .commit_from_file(dir.join(spec.onnx_file))
            .with_context(|| format!("loading {}", spec.onnx_file))?;
        let input_names = session.inputs.iter().map(|i| i.name.clone()).collect();
        Ok(Self { spec, session: Mutex::new(session), tokenizer, input_names })
    }

    pub fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        let mut out = self.embed(&[format!("{}{}", self.spec.query_prefix, text)])?;
        out.pop().ok_or_else(|| anyhow!("no embedding"))
    }

    pub fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let prefixed: Vec<String> = texts.iter().map(|t| format!("{}{}", self.spec.passage_prefix, t)).collect();
        self.embed(&prefixed)
    }

    /// Mean-pooled over real tokens, L2-normalised.
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let encodings = self.tokenizer.encode_batch(texts.to_vec(), true).map_err(|e| anyhow!("tokenize: {e}"))?;
        let batch = encodings.len();
        let len = encodings[0].get_ids().len();
        let ids: Vec<i64> = encodings.iter().flat_map(|e| e.get_ids().iter().map(|&x| x as i64)).collect();
        let mask: Vec<i64> = encodings.iter().flat_map(|e| e.get_attention_mask().iter().map(|&x| x as i64)).collect();

        let mut inputs: Vec<(Cow<str>, SessionInputValue)> = Vec::new();
        for name in &self.input_names {
            let data = match name.as_str() {
                "input_ids" => ids.clone(),
                "attention_mask" => mask.clone(),
                "token_type_ids" => vec![0; batch * len],
                other => return Err(anyhow!("unexpected model input {other}")),
            };
            inputs.push((Cow::Owned(name.clone()), Tensor::from_array(([batch, len], data))?.into()));
        }

        let mut session = self.session.lock().map_err(|_| anyhow!("embedding session poisoned"))?;
        let outputs = session.run(inputs)?;
        let (shape, hidden) = outputs[0].try_extract_tensor::<f32>()?;
        let dim = *shape.last().ok_or_else(|| anyhow!("bad output shape"))? as usize;

        let mut out = Vec::with_capacity(batch);
        for b in 0..batch {
            // Summing is enough: normalising afterwards cancels the mean's divisor.
            let mut pooled = vec![0f32; dim];
            for t in (0..len).filter(|&t| mask[b * len + t] != 0) {
                let row = &hidden[(b * len + t) * dim..(b * len + t + 1) * dim];
                pooled.iter_mut().zip(row).for_each(|(p, v)| *p += v);
            }
            let norm = pooled.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-12);
            pooled.iter_mut().for_each(|v| *v /= norm);
            out.push(pooled);
        }
        Ok(out)
    }
}

/// Unit vector → int8 bytes plus its scale (a quarter of the size of f32).
pub fn quantize(vector: &[f32]) -> Vec<u8> {
    let max = vector.iter().fold(0f32, |m, v| m.max(v.abs())).max(1e-12);
    let scale = max / 127.0;
    let mut bytes = scale.to_le_bytes().to_vec();
    bytes.extend(vector.iter().map(|v| (v / scale).round().clamp(-127.0, 127.0) as i8 as u8));
    bytes
}

/// Dot product of a stored int8 vector with an f32 query; cosine for unit vectors.
pub fn similarity(stored: &[u8], query: &[f32]) -> Option<f32> {
    if stored.len() != query.len() + 4 {
        return None;
    }
    let scale = f32::from_le_bytes(stored[..4].try_into().ok()?);
    let dot: f32 = stored[4..].iter().zip(query).map(|(&q, &x)| (q as i8) as f32 * x).sum();
    Some(dot * scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantized_similarity_is_close_to_exact() {
        let a: Vec<f32> = (0..384).map(|i| ((i * 7 % 13) as f32 - 6.0) / 10.0).collect();
        let norm = a.iter().map(|v| v * v).sum::<f32>().sqrt();
        let a: Vec<f32> = a.iter().map(|v| v / norm).collect();
        let sim = similarity(&quantize(&a), &a).unwrap();
        assert!((sim - 1.0).abs() < 0.01, "{sim}");
    }
}
