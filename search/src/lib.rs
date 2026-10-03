//! Riff's search engine, shared by every search in the product: the meetings
//! list, the journal shelf (both through the Tauri app) and the Dev Sessions
//! agents' `search_docs` (through `riff-search` / `riff --search-stdio`, see
//! `stdio.rs`).
//!
//! Callers hand over [`Document`]s made of [`Segment`]s (transcript lines,
//! paragraphs, doc sections). The index splits them into ~1k-character chunks
//! and keeps them in one SQLite file with:
//! - an FTS5 table (porter stemming, BM25 with title > heading > body), and
//! - an int8 embedding per chunk from a local ONNX model ([`Embedder`]),
//!   filled in the background by [`Index::embed_pending`].
//!
//! A query runs both, fuses the two rankings by reciprocal rank and groups
//! chunks into results ([`Index::search`]). Without a model it is keyword-only.
//! The index is derived data: callers reconcile it from their own store by
//! fingerprint ([`Index::fingerprints`] + [`diff`]), and it can be deleted
//! and rebuilt at any time.

mod chunk;
mod embed;
pub mod markdown;
mod query;
pub mod stdio;
mod store;

pub use embed::{verify_sha256, Embedder, ModelFile, ModelSpec, DEFAULT_MODEL};
pub use store::{Index, Status};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One searchable thing, e.g. a meeting's transcript or a docs file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    /// Unique within its scope.
    pub key: String,
    /// What it is ("transcript", "summary", "journal", "doc", …); queries filter on it.
    pub kind: String,
    pub title: String,
    /// What results are grouped by (a meeting id, a journal id, a file). Defaults to `key`.
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    /// Returned with every hit, untouched.
    #[serde(default)]
    pub meta: serde_json::Value,
    /// Changes whenever the content does; an unchanged fingerprint is not re-indexed.
    pub fingerprint: String,
    pub segments: Vec<Segment>,
}

/// A transcript line, a paragraph or a doc section. Chunks never span two headings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub text: String,
    #[serde(default)]
    pub heading: Option<String>,
    /// Seconds into the recording, for transcript lines.
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub text: String,
    pub scopes: Vec<String>,
    /// Only these kinds; empty means all.
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// One result per group (with up to two more matching chunks in `also`)
    /// instead of one per chunk.
    #[serde(default)]
    pub grouped: bool,
}

fn default_limit() -> usize {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub scope: String,
    pub key: String,
    pub kind: String,
    pub title: String,
    pub group: String,
    pub date: Option<String>,
    pub meta: serde_json::Value,
    pub heading: Option<String>,
    /// The whole chunk.
    pub text: String,
    /// A short excerpt; matched terms are wrapped in [`MARK_START`]/[`MARK_END`].
    pub snippet: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub score: f64,
    /// Found by keyword match.
    pub keyword: bool,
    /// Found by meaning (embedding similarity).
    pub semantic: bool,
    /// Grouped queries: other matching chunks of the same group, best first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<Hit>,
}

pub const MARK_START: char = '\u{2}';
pub const MARK_END: char = '\u{3}';

/// Keys whose fingerprint differs from (or is missing in) the index, and
/// indexed keys that are no longer wanted.
pub fn diff(indexed: &HashMap<String, String>, wanted: &HashMap<String, String>) -> (Vec<String>, Vec<String>) {
    let changed = wanted
        .iter()
        .filter(|(key, fp)| indexed.get(*key) != Some(*fp))
        .map(|(key, _)| key.clone())
        .collect();
    let removed = indexed.keys().filter(|key| !wanted.contains_key(*key)).cloned().collect();
    (changed, removed)
}
