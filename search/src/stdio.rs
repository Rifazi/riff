//! The index over stdin/stdout, one JSON object per line, for processes that
//! aren't Rust (the Dev Sessions agent server). Started as `riff-search` or
//! `riff --search-stdio`, with `--index <file>` and optionally
//! `--model-dir <dir>`; exits when stdin closes.
//!
//! Request:  {"id": 1, "op": "search", ...fields}
//! Response: {"id": 1, "ok": true, "result": ...} or {"id": 1, "ok": false, "error": "..."}
//!
//! Ops: `fingerprints {scope}` → {key: fingerprint}; `upsert {scope, docs}`;
//! `remove {scope, keys}`; `remove_scope {scope}`; `search {query}` → [Hit];
//! `status`. New chunks are embedded in the background after each upsert.

use crate::{Document, Embedder, Index, Query, DEFAULT_MODEL};
use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Fingerprints { scope: String },
    Upsert { scope: String, docs: Vec<Document> },
    Remove { scope: String, keys: Vec<String> },
    RemoveScope { scope: String },
    Search { query: Query },
    Status,
}

/// Parses `--index` / `--model-dir` from `args` and serves until stdin closes.
pub fn main_from_args(args: impl Iterator<Item = String>) -> Result<()> {
    let mut index_path: Option<PathBuf> = None;
    let mut model_dir: Option<PathBuf> = None;
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--index" => index_path = args.next().map(PathBuf::from),
            "--model-dir" => model_dir = args.next().map(PathBuf::from),
            _ => {}
        }
    }
    let index_path = index_path.ok_or_else(|| anyhow!("--index <file> is required"))?;
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(serve(index_path, model_dir))
}

pub async fn serve(index_path: PathBuf, model_dir: Option<PathBuf>) -> Result<()> {
    let index = Arc::new(Index::open(&index_path).await?);
    if let Some(dir) = model_dir.map(|d| d.join(DEFAULT_MODEL.dir)) {
        if DEFAULT_MODEL.is_installed(&dir) {
            // A panic here (ONNX Runtime missing) must not take keyword search down with it.
            match tokio::task::spawn_blocking(move || Embedder::load(&dir, &DEFAULT_MODEL)).await {
                Ok(Ok(embedder)) => index.set_embedder(Some(Arc::new(embedder))).await?,
                Ok(Err(e)) => log::warn!("riff-search: embedding model failed to load, keyword search only: {e}"),
                Err(e) => log::warn!("riff-search: embedding model failed to load, keyword search only: {e}"),
            }
        }
    }
    // Picks up anything a previous run left unembedded.
    spawn_embedding(index.clone());

    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let index = index.clone();
        let stdout = stdout.clone();
        // Concurrent: a slow upsert doesn't hold up a search.
        tokio::spawn(async move {
            let value: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let response = match handle(&index, value).await {
                Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                Err(e) => json!({ "id": id, "ok": false, "error": e.to_string() }),
            };
            let mut out = stdout.lock().await;
            let _ = out.write_all(format!("{response}\n").as_bytes()).await;
            let _ = out.flush().await;
        });
    }
    Ok(())
}

async fn handle(index: &Arc<Index>, value: Value) -> Result<Value> {
    let request: Request = serde_json::from_value(value)?;
    Ok(match request {
        Request::Fingerprints { scope } => json!(index.fingerprints(&scope).await?),
        Request::Upsert { scope, docs } => {
            for doc in &docs {
                index.upsert(&scope, doc).await?;
            }
            spawn_embedding(index.clone());
            json!(docs.len())
        }
        Request::Remove { scope, keys } => {
            index.remove(&scope, &keys).await?;
            json!(keys.len())
        }
        Request::RemoveScope { scope } => {
            index.remove_scope(&scope).await?;
            json!(true)
        }
        Request::Search { query } => json!(index.search(&query).await?),
        Request::Status => json!(index.status().await?),
    })
}

fn spawn_embedding(index: Arc<Index>) {
    if index.embedder().is_none() {
        return;
    }
    tokio::spawn(async move {
        if let Err(e) = index.embed_pending(usize::MAX).await {
            log::warn!("riff-search: embedding failed: {e}");
        }
    });
}
