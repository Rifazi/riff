use crate::chunk::chunk_segments;
use crate::embed::{quantize, similarity, Embedder};
use crate::query::{match_expressions, plain_snippet, rrf};
use crate::{Document, Hit, Query};
use anyhow::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Bump to rebuild every index on next open (it is derived data).
const SCHEMA_VERSION: &str = "1";
/// How many chunks each ranking contributes to the fusion.
const CANDIDATES: usize = 80;
const EMBED_BATCH: usize = 16;
const SNIPPET_CHARS: usize = 220;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    grp TEXT NOT NULL,
    date TEXT,
    meta TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    UNIQUE (scope, key)
);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    heading TEXT,
    text TEXT NOT NULL,
    start_time REAL,
    end_time REAL,
    -- Hash of what was embedded, so re-indexing an unchanged chunk keeps its vector.
    embed_hash TEXT NOT NULL,
    embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS chunks_unembedded ON chunks(id) WHERE embedding IS NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    title, heading, body,
    tokenize = 'porter unicode61 remove_diacritics 2'
);
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub documents: i64,
    pub chunks: i64,
    pub embedded: i64,
    /// The loaded embedding model, if any.
    pub model: Option<String>,
}

pub struct Index {
    pool: SqlitePool,
    embedder: RwLock<Option<Arc<Embedder>>>,
    /// One embedding pass at a time.
    embedding: tokio::sync::Mutex<()>,
    /// One write transaction at a time. Each starts deferred (reads, then
    /// writes), and in WAL mode SQLite refuses that upgrade with SQLITE_BUSY
    /// at once, without waiting, when another connection is mid-write.
    writing: tokio::sync::Mutex<()>,
}

impl Index {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(10));
        let pool = SqlitePoolOptions::new().max_connections(4).connect_with(options).await?;
        Self::init(pool).await
    }

    pub async fn open_in_memory() -> Result<Self> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(options).await?;
        Self::init(pool).await
    }

    async fn init(pool: SqlitePool) -> Result<Self> {
        let version: Option<String> = match sqlx::query_scalar("SELECT value FROM meta WHERE key = 'schema'")
            .fetch_optional(&pool)
            .await
        {
            Ok(v) => v,
            Err(_) => None,
        };
        if version.as_deref() != Some(SCHEMA_VERSION) {
            for table in ["chunks_fts", "chunks", "docs", "meta"] {
                sqlx::query(&format!("DROP TABLE IF EXISTS {table}")).execute(&pool).await?;
            }
        }
        sqlx::raw_sql(SCHEMA).execute(&pool).await?;
        sqlx::query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)")
            .bind(SCHEMA_VERSION)
            .execute(&pool)
            .await?;
        Ok(Self {
            pool,
            embedder: RwLock::new(None),
            embedding: tokio::sync::Mutex::new(()),
            writing: tokio::sync::Mutex::new(()),
        })
    }

    /// Attaches (or detaches) the embedding model. Vectors from a different
    /// model are dropped so they get recomputed.
    pub async fn set_embedder(&self, embedder: Option<Arc<Embedder>>) -> Result<()> {
        if let Some(e) = &embedder {
            let _write = self.writing.lock().await;
            let current: Option<String> = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'embedding_model'")
                .fetch_optional(&self.pool)
                .await?;
            if current.as_deref() != Some(e.spec.id) {
                sqlx::query("UPDATE chunks SET embedding = NULL").execute(&self.pool).await?;
                sqlx::query("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_model', ?)")
                    .bind(e.spec.id)
                    .execute(&self.pool)
                    .await?;
            }
        }
        *self.embedder.write().unwrap() = embedder;
        Ok(())
    }

    pub fn embedder(&self) -> Option<Arc<Embedder>> {
        self.embedder.read().unwrap().clone()
    }

    /// Caller settings kept with the index.
    pub async fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(sqlx::query_scalar("SELECT value FROM meta WHERE key = ?")
            .bind(format!("setting:{key}"))
            .fetch_optional(&self.pool)
            .await?)
    }

    pub async fn set_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        let _write = self.writing.lock().await;
        let key = format!("setting:{key}");
        match value {
            Some(v) => sqlx::query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key).bind(v),
            None => sqlx::query("DELETE FROM meta WHERE key = ?").bind(key),
        }
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn fingerprints(&self, scope: &str) -> Result<HashMap<String, String>> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, fingerprint FROM docs WHERE scope = ?")
            .bind(scope)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().collect())
    }

    /// Replaces the document's chunks. Chunks whose embedded text is unchanged
    /// keep their vectors.
    pub async fn upsert(&self, scope: &str, doc: &Document) -> Result<()> {
        let chunks = chunk_segments(&doc.segments);
        let _write = self.writing.lock().await;
        let mut tx = self.pool.begin().await?;

        let old: Option<i64> = sqlx::query_scalar("SELECT id FROM docs WHERE scope = ? AND key = ?")
            .bind(scope)
            .bind(&doc.key)
            .fetch_optional(&mut *tx)
            .await?;
        let mut reusable: HashMap<String, Vec<u8>> = HashMap::new();
        if let Some(old) = old {
            let rows: Vec<(String, Vec<u8>)> =
                sqlx::query_as("SELECT embed_hash, embedding FROM chunks WHERE doc_id = ? AND embedding IS NOT NULL")
                    .bind(old)
                    .fetch_all(&mut *tx)
                    .await?;
            reusable.extend(rows);
            sqlx::query("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)")
                .bind(old)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM chunks WHERE doc_id = ?").bind(old).execute(&mut *tx).await?;
        }

        let doc_id: i64 = sqlx::query_scalar(
            "INSERT INTO docs (scope, key, kind, title, grp, date, meta, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (scope, key) DO UPDATE SET kind = excluded.kind, title = excluded.title, grp = excluded.grp,
                 date = excluded.date, meta = excluded.meta, fingerprint = excluded.fingerprint
             RETURNING id",
        )
        .bind(scope)
        .bind(&doc.key)
        .bind(&doc.kind)
        .bind(&doc.title)
        .bind(doc.group.as_deref().unwrap_or(&doc.key))
        .bind(&doc.date)
        .bind(doc.meta.to_string())
        .bind(&doc.fingerprint)
        .fetch_one(&mut *tx)
        .await?;

        for chunk in &chunks {
            let input = embed_input(&doc.title, chunk.heading.as_deref(), &chunk.text);
            let hash = short_hash(&input);
            let chunk_id: i64 = sqlx::query_scalar(
                "INSERT INTO chunks (doc_id, heading, text, start_time, end_time, embed_hash, embedding)
                 VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .bind(doc_id)
            .bind(&chunk.heading)
            .bind(&chunk.text)
            .bind(chunk.start)
            .bind(chunk.end)
            .bind(&hash)
            .bind(reusable.get(&hash))
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO chunks_fts (rowid, title, heading, body) VALUES (?, ?, ?, ?)")
                .bind(chunk_id)
                .bind(&doc.title)
                .bind(chunk.heading.as_deref().unwrap_or(""))
                .bind(&chunk.text)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn remove(&self, scope: &str, keys: &[String]) -> Result<()> {
        let _write = self.writing.lock().await;
        let mut tx = self.pool.begin().await?;
        for key in keys {
            sqlx::query(
                "DELETE FROM chunks_fts WHERE rowid IN
                 (SELECT c.id FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE d.scope = ? AND d.key = ?)",
            )
            .bind(scope)
            .bind(key)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM docs WHERE scope = ? AND key = ?").bind(scope).bind(key).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn remove_scope(&self, scope: &str) -> Result<()> {
        let keys: Vec<String> = self.fingerprints(scope).await?.into_keys().collect();
        self.remove(scope, &keys).await
    }

    /// Makes `scope` hold exactly `docs`, re-indexing only changed fingerprints.
    /// Returns how many documents were (re)indexed.
    pub async fn sync_scope(&self, scope: &str, docs: &[Document]) -> Result<usize> {
        let indexed = self.fingerprints(scope).await?;
        let wanted: HashMap<String, String> = docs.iter().map(|d| (d.key.clone(), d.fingerprint.clone())).collect();
        let (changed, removed) = crate::diff(&indexed, &wanted);
        let changed: HashSet<String> = changed.into_iter().collect();
        for doc in docs.iter().filter(|d| changed.contains(&d.key)) {
            self.upsert(scope, doc).await?;
        }
        self.remove(scope, &removed).await?;
        Ok(changed.len())
    }

    /// Drops everything (the caller re-syncs).
    pub async fn clear(&self) -> Result<()> {
        let _write = self.writing.lock().await;
        sqlx::raw_sql("DELETE FROM chunks_fts; DELETE FROM chunks; DELETE FROM docs;").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn status(&self) -> Result<Status> {
        let row = sqlx::query(
            "SELECT (SELECT COUNT(*) FROM docs), (SELECT COUNT(*) FROM chunks),
                    (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL)",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(Status {
            documents: row.get(0),
            chunks: row.get(1),
            embedded: row.get(2),
            model: self.embedder().map(|e| e.spec.id.to_string()),
        })
    }

    /// Embeds chunks that have no vector yet, up to `max`. Returns how many.
    pub async fn embed_pending(&self, max: usize) -> Result<usize> {
        let Some(embedder) = self.embedder() else { return Ok(0) };
        let _one_at_a_time = self.embedding.lock().await;
        let mut done = 0;
        while done < max {
            let rows: Vec<(i64, String, Option<String>, String)> = sqlx::query_as(
                "SELECT c.id, d.title, c.heading, c.text FROM chunks c JOIN docs d ON d.id = c.doc_id
                 WHERE c.embedding IS NULL ORDER BY c.id LIMIT ?",
            )
            .bind(EMBED_BATCH as i64)
            .fetch_all(&self.pool)
            .await?;
            if rows.is_empty() {
                break;
            }
            let inputs: Vec<String> = rows.iter().map(|(_, t, h, x)| embed_input(t, h.as_deref(), x)).collect();
            let model = embedder.clone();
            let vectors = tokio::task::spawn_blocking(move || model.embed_passages(&inputs)).await??;
            let _write = self.writing.lock().await;
            let mut tx = self.pool.begin().await?;
            for ((id, ..), vector) in rows.iter().zip(vectors) {
                sqlx::query("UPDATE chunks SET embedding = ? WHERE id = ?")
                    .bind(quantize(&vector))
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
            done += rows.len();
        }
        Ok(done)
    }

    pub async fn search(&self, query: &Query) -> Result<Vec<Hit>> {
        let text = query.text.trim();
        if text.is_empty() || query.scopes.is_empty() || query.limit == 0 {
            return Ok(Vec::new());
        }

        // Keyword ranking: every term first, then any term to fill up.
        let mut keyword: Vec<(i64, String)> = Vec::new();
        if let Some(expressions) = match_expressions(text) {
            keyword = self.keyword_candidates(query, &expressions.all, CANDIDATES).await?;
            if keyword.len() < CANDIDATES {
                if let Some(any) = &expressions.any {
                    let seen: HashSet<i64> = keyword.iter().map(|(id, _)| *id).collect();
                    let more = self.keyword_candidates(query, any, CANDIDATES).await?;
                    keyword.extend(more.into_iter().filter(|(id, _)| !seen.contains(id)));
                }
            }
        }
        let semantic = self.semantic_candidates(query, text).await.unwrap_or_else(|e| {
            log::warn!("semantic search failed, using keywords only: {e}");
            Vec::new()
        });

        // Reciprocal rank fusion.
        struct Fused {
            score: f64,
            snippet: Option<String>,
            semantic: bool,
        }
        let mut fused: HashMap<i64, Fused> = HashMap::new();
        for (rank, (id, snippet)) in keyword.into_iter().enumerate() {
            fused.insert(id, Fused { score: rrf(rank), snippet: Some(snippet), semantic: false });
        }
        for (rank, candidate) in semantic.into_iter().enumerate() {
            // Meaning reorders keyword matches freely, but only a clear
            // standout is shown when no keyword matched.
            match fused.get_mut(&candidate.id) {
                Some(entry) => {
                    entry.score += rrf(rank);
                    entry.semantic |= candidate.standout;
                }
                None if candidate.standout => {
                    fused.insert(candidate.id, Fused { score: rrf(rank), snippet: None, semantic: true });
                }
                None => {}
            }
        }
        let mut ranked: Vec<(i64, Fused)> = fused.into_iter().collect();
        ranked.sort_by(|a, b| b.1.score.total_cmp(&a.1.score).then(a.0.cmp(&b.0)));
        ranked.truncate(if query.grouped { CANDIDATES * 2 } else { query.limit });

        let ids: Vec<i64> = ranked.iter().map(|(id, _)| *id).collect();
        let mut details = self.chunk_details(&ids).await?;
        let mut hits: Vec<Hit> = Vec::new();
        for (id, f) in ranked {
            let Some(mut hit) = details.remove(&id) else { continue };
            hit.score = f.score;
            hit.keyword = f.snippet.is_some();
            hit.semantic = f.semantic;
            hit.snippet = match f.snippet {
                Some(s) if s.contains(crate::MARK_START) => s,
                _ => plain_snippet(&hit.text, text, SNIPPET_CHARS),
            };
            hits.push(hit);
        }
        if !query.grouped {
            return Ok(hits);
        }

        let mut groups: Vec<Hit> = Vec::new();
        let mut index: HashMap<(String, String), usize> = HashMap::new();
        for hit in hits {
            let key = (hit.scope.clone(), hit.group.clone());
            match index.get(&key) {
                Some(&at) => {
                    if groups[at].also.len() < 2 {
                        groups[at].also.push(hit);
                    }
                }
                None if groups.len() < query.limit => {
                    index.insert(key, groups.len());
                    groups.push(hit);
                }
                None => {}
            }
        }
        Ok(groups)
    }

    async fn keyword_candidates(&self, query: &Query, expression: &str, limit: usize) -> Result<Vec<(i64, String)>> {
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(format!(
            "SELECT c.id, snippet(chunks_fts, 2, '{}', '{}', '…', 24)
             FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN docs d ON d.id = c.doc_id
             WHERE chunks_fts MATCH ",
            crate::MARK_START,
            crate::MARK_END
        ));
        qb.push_bind(expression.to_string());
        push_filters(&mut qb, query);
        // Title and heading matches count for more than body text.
        qb.push(" ORDER BY bm25(chunks_fts, 4.0, 2.0, 1.0) LIMIT ").push_bind(limit as i64);
        let rows: Vec<(i64, String)> = qb.build_query_as().fetch_all(&self.pool).await?;
        Ok(rows)
    }

    /// The chunks most similar in meaning, best first.
    async fn semantic_candidates(&self, query: &Query, text: &str) -> Result<Vec<SemanticCandidate>> {
        let Some(embedder) = self.embedder() else { return Ok(Vec::new()) };
        // Too short to carry meaning; keyword search covers it.
        if text.chars().filter(|c| c.is_alphanumeric()).count() < 3 {
            return Ok(Vec::new());
        }
        let input = text.to_string();
        let model = embedder.clone();
        let vector = tokio::task::spawn_blocking(move || model.embed_query(&input)).await??;

        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
            "SELECT c.id, c.embedding FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.embedding IS NOT NULL",
        );
        push_filters(&mut qb, query);
        let rows: Vec<(i64, Vec<u8>)> = qb.build_query_as().fetch_all(&self.pool).await?;
        let mut scored: Vec<(i64, f32)> =
            rows.iter().filter_map(|(id, stored)| similarity(stored, &vector).map(|s| (*id, s))).collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        let standout = standout_test(&scored, embedder.spec);
        scored.truncate(CANDIDATES);
        Ok(scored.into_iter().map(|(id, sim)| SemanticCandidate { id, standout: standout(sim) }).collect())
    }

    async fn chunk_details(&self, ids: &[i64]) -> Result<HashMap<i64, Hit>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
            "SELECT c.id, d.scope, d.key, d.kind, d.title, d.grp, d.date, d.meta, c.heading, c.text, c.start_time, c.end_time
             FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id IN (",
        );
        let mut list = qb.separated(", ");
        for id in ids {
            list.push_bind(*id);
        }
        qb.push(")");
        let rows = qb.build().fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let meta: String = row.get(7);
                (
                    row.get::<i64, _>(0),
                    Hit {
                        scope: row.get(1),
                        key: row.get(2),
                        kind: row.get(3),
                        title: row.get(4),
                        group: row.get(5),
                        date: row.get(6),
                        meta: serde_json::from_str(&meta).unwrap_or(serde_json::Value::Null),
                        heading: row.get(8),
                        text: row.get(9),
                        snippet: String::new(),
                        start: row.get(10),
                        end: row.get(11),
                        score: 0.0,
                        keyword: false,
                        semantic: false,
                        also: Vec::new(),
                    },
                )
            })
            .collect())
    }
}

struct SemanticCandidate {
    id: i64,
    /// Similar enough to show even without a keyword match.
    standout: bool,
}

/// Decides which similarities are real matches rather than the best of a
/// bad lot. Embedding models squeeze every score into a narrow band (e5
/// gives "weather in paris" 0.85 against a product meeting), so a fixed
/// cut-off can't tell. Instead a match has to stand out from this query's
/// own scores across the corpus: more standard deviations above their mean
/// than the expected maximum of that many unrelated scores (Gumbel
/// approximation; ~1.9 for 32 chunks, ~3.1 for 1,000, ~4.3 for 100,000).
/// Too few chunks for statistics: fall back to the model's absolute floor.
fn standout_test(sorted: &[(i64, f32)], spec: &crate::ModelSpec) -> impl Fn(f32) -> bool {
    const MIN_FOR_STATISTICS: usize = 12;
    const MARGIN: f32 = 0.1;
    let n = sorted.len();
    let best = sorted.first().map_or(0.0, |s| s.1);
    let (mean, sd) = if n >= MIN_FOR_STATISTICS {
        let mean = sorted.iter().map(|s| s.1).sum::<f32>() / n as f32;
        let var = sorted.iter().map(|s| (s.1 - mean).powi(2)).sum::<f32>() / n as f32;
        (mean, var.sqrt().max(1e-6))
    } else {
        (0.0, 0.0)
    };
    let ceiling = expected_noise_max(n) + MARGIN;
    let (floor, window) = (spec.min_similarity, spec.similarity_window);
    move |sim: f32| {
        if n >= MIN_FOR_STATISTICS {
            (sim - mean) / sd >= ceiling
        } else {
            sim >= floor && sim >= best - window
        }
    }
}

/// Expected maximum of n standard normal samples.
fn expected_noise_max(n: usize) -> f32 {
    let n = (n.max(2)) as f32;
    let a = (2.0 * n.ln()).sqrt();
    a - (n.ln().ln() + (4.0 * std::f32::consts::PI).ln()) / (2.0 * a)
}

fn push_filters(qb: &mut QueryBuilder<Sqlite>, query: &Query) {
    qb.push(" AND d.scope IN (");
    let mut scopes = qb.separated(", ");
    for scope in &query.scopes {
        scopes.push_bind(scope.clone());
    }
    qb.push(")");
    if !query.kinds.is_empty() {
        qb.push(" AND d.kind IN (");
        let mut kinds = qb.separated(", ");
        for kind in &query.kinds {
            kinds.push_bind(kind.clone());
        }
        qb.push(")");
    }
}

/// What gets embedded: the chunk in its context. A transcript line like
/// "let's push that to next sprint" means little without the meeting's title.
fn embed_input(title: &str, heading: Option<&str>, text: &str) -> String {
    match heading {
        Some(h) if !h.is_empty() => format!("{title}\n{h}\n{text}"),
        _ => format!("{title}\n{text}"),
    }
}

fn short_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())[..12].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Segment;

    fn transcript(key: &str, title: &str, lines: &[&str]) -> Document {
        Document {
            key: key.into(),
            kind: "transcript".into(),
            title: title.into(),
            group: Some(format!("meeting-{key}")),
            date: None,
            meta: serde_json::json!({ "meetingId": key }),
            fingerprint: lines.join("|"),
            segments: lines
                .iter()
                .enumerate()
                .map(|(i, l)| Segment { text: l.to_string(), start: Some(i as f64 * 10.0), end: None, heading: None })
                .collect(),
        }
    }

    fn query(text: &str) -> Query {
        Query { text: text.into(), scopes: vec!["s".into()], kinds: vec![], limit: 10, grouped: true }
    }

    #[tokio::test]
    async fn keyword_search_stems_ranks_titles_and_groups() {
        let index = Index::open_in_memory().await.unwrap();
        index
            .sync_scope(
                "s",
                &[
                    transcript("a", "Hiring plan", &["We are hiring two engineers.", "Budget is fine."]),
                    transcript("b", "Weekly sync", &["Someone mentioned hires in passing."]),
                    transcript("c", "Roadmap", &["Nothing relevant here."]),
                ],
            )
            .await
            .unwrap();

        let hits = index.search(&query("hire")).await.unwrap();
        let keys: Vec<&str> = hits.iter().map(|h| h.key.as_str()).collect();
        assert_eq!(keys, vec!["a", "b"], "porter stemming matches hiring/hires; the title match ranks first");
        assert!(hits[0].snippet.contains(crate::MARK_START));
        assert_eq!(hits[0].start, Some(0.0));
        assert_eq!(hits[0].meta["meetingId"], "a");

        // Other scopes and kinds are filtered out.
        let mut other = query("hire");
        other.kinds = vec!["summary".into()];
        assert!(index.search(&other).await.unwrap().is_empty());
        other.kinds.clear();
        other.scopes = vec!["elsewhere".into()];
        assert!(index.search(&other).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sync_reindexes_changes_and_removes_missing_docs() {
        let index = Index::open_in_memory().await.unwrap();
        let first = vec![transcript("a", "One", &["apples"]), transcript("b", "Two", &["bananas"])];
        assert_eq!(index.sync_scope("s", &first).await.unwrap(), 2);
        assert_eq!(index.sync_scope("s", &first).await.unwrap(), 0, "unchanged fingerprints are skipped");

        let second = vec![transcript("a", "One", &["cherries"])];
        assert_eq!(index.sync_scope("s", &second).await.unwrap(), 1);
        assert!(index.search(&query("apples")).await.unwrap().is_empty());
        assert!(index.search(&query("bananas")).await.unwrap().is_empty());
        assert_eq!(index.search(&query("cherries")).await.unwrap().len(), 1);
        let status = index.status().await.unwrap();
        assert_eq!((status.documents, status.chunks), (1, 1));
        let fts_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chunks_fts").fetch_one(&index.pool).await.unwrap();
        assert_eq!(fts_rows, 1, "no orphaned keyword rows");
    }

    #[tokio::test]
    async fn concurrent_writes_do_not_fail_with_busy() {
        let dir = tempfile::tempdir().unwrap();
        let index = Arc::new(Index::open(&dir.path().join("i.sqlite")).await.unwrap());
        let tasks: Vec<_> = (0..8)
            .map(|i| {
                let index = index.clone();
                tokio::spawn(async move {
                    let doc = transcript(&format!("d{i}"), "T", &["some words", "more words"]);
                    index.upsert("s", &doc).await?;
                    index.remove("s", &[format!("missing{i}")]).await
                })
            })
            .collect();
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert_eq!(index.status().await.unwrap().documents, 8);
    }

    #[test]
    fn noise_ceiling_grows_with_the_corpus() {
        let at = |n| (expected_noise_max(n) * 10.0).round() / 10.0;
        assert_eq!((at(32), at(1_000), at(100_000)), (1.9, 3.1, 4.3));
    }

    #[tokio::test]
    async fn any_term_fills_in_when_not_every_term_matches() {
        let index = Index::open_in_memory().await.unwrap();
        index.sync_scope("s", &[transcript("a", "Sync", &["pricing tiers were discussed"])]).await.unwrap();
        let hits = index.search(&query("pricing for enterprise ")).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert!(index.search(&query("\"tiers pricing\"")).await.unwrap().is_empty(), "phrases stay phrases");
    }
}
