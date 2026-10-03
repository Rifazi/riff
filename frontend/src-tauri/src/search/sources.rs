//! What the app indexes, and how it notices changes without hooks in every
//! write path: each source document gets a fingerprint from a cheap query,
//! and only documents whose fingerprint differs from the index are loaded and
//! re-indexed.
//!
//! | key                  | kind           | group       | content                         |
//! |----------------------|----------------|-------------|---------------------------------|
//! | `transcript:<meet>`  | transcript     | meeting id  | transcript lines with times     |
//! | `summary:<meet>`     | summary        | meeting id  | the completed AI summary        |
//! | `journal:<book>`     | journal        | notebook id | title, description, overview    |
//! | `note:<entry>`       | journal_note   | notebook id | a filed note and its key points |

use super::{KIND_JOURNAL, KIND_JOURNAL_NOTE, KIND_SUMMARY, KIND_TRANSCRIPT, SCOPE};
use crate::journal::repository::JournalRepository;
use anyhow::Result;
use riff_search::{diff, markdown, Document, Index, Segment};
use serde_json::json;
use sqlx::SqlitePool;
use std::collections::HashMap;

/// Returns how many documents were (re)indexed.
pub async fn sync_all(index: &Index, pool: &SqlitePool) -> Result<usize> {
    let mut wanted: HashMap<String, String> = HashMap::new();

    // Transcript rows are only ever inserted or deleted (retranscription
    // replaces them), so count + highest rowid catches every change.
    let meetings: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT m.id, m.title, COUNT(t.id), COALESCE(MAX(t.rowid), 0)
         FROM meetings m LEFT JOIN transcripts t ON t.meeting_id = m.id GROUP BY m.id",
    )
    .fetch_all(pool)
    .await?;
    for (id, title, count, max_row) in &meetings {
        wanted.insert(format!("transcript:{id}"), format!("{title}|{count}|{max_row}"));
    }

    let summaries: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT s.meeting_id, m.title, s.updated_at FROM summary_processes s JOIN meetings m ON m.id = s.meeting_id
         WHERE s.status = 'completed' AND s.result IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    for (id, title, updated) in &summaries {
        wanted.insert(format!("summary:{id}"), format!("{title}|{updated}"));
    }

    // Journals are few and small: fingerprint by content.
    let journals: Vec<(String, String, Option<String>, Option<String>, String)> =
        sqlx::query_as("SELECT id, title, description, summary_markdown, color FROM notebooks").fetch_all(pool).await?;
    for (id, title, description, overview, _) in &journals {
        let content = format!("{title}\u{0}{}\u{0}{}", description.as_deref().unwrap_or(""), overview.as_deref().unwrap_or(""));
        wanted.insert(format!("journal:{id}"), format!("{:x}", fnv1a(&content)));
    }

    // Notes are written once; filing moves them between journals.
    let notes: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT e.id, e.notebook_id, n.title, e.title, LENGTH(e.summary) + COALESCE(LENGTH(e.key_points), 0)
         FROM notebook_entries e JOIN notebooks n ON n.id = e.notebook_id WHERE e.status = 'filed'",
    )
    .fetch_all(pool)
    .await?;
    for (id, notebook_id, notebook_title, title, len) in &notes {
        wanted.insert(format!("note:{id}"), format!("{notebook_id}|{notebook_title}|{title}|{len}"));
    }

    let indexed = index.fingerprints(SCOPE).await?;
    let (changed, removed) = diff(&indexed, &wanted);
    let journals_by_id: HashMap<&str, _> = journals.iter().map(|j| (j.0.as_str(), j)).collect();

    let mut done = 0;
    for key in &changed {
        let (kind, id) = key.split_once(':').unwrap_or(("", ""));
        let doc = match kind {
            "transcript" => transcript_doc(pool, id).await?,
            "summary" => summary_doc(pool, id).await?,
            "journal" => journals_by_id.get(id).map(|(id, title, description, overview, color)| {
                journal_doc(id, title, description.as_deref(), overview.as_deref(), color)
            }),
            "note" => note_doc(pool, id).await?,
            _ => None,
        };
        // Deleted between the two queries: picked up as removed next time.
        let Some(mut doc) = doc else { continue };
        doc.key = key.clone();
        doc.fingerprint = wanted[key].clone();
        index.upsert(SCOPE, &doc).await?;
        done += 1;
    }
    index.remove(SCOPE, &removed).await?;
    Ok(done + removed.len())
}

fn fnv1a(text: &str) -> u64 {
    // FNV-1a: stable across runs, unlike std's randomly seeded hasher.
    text.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

fn doc(kind: &str, title: String, group: &str, date: Option<String>, meta: serde_json::Value, segments: Vec<Segment>) -> Document {
    Document {
        key: String::new(),
        kind: kind.into(),
        title,
        group: Some(group.into()),
        date,
        meta,
        fingerprint: String::new(),
        segments,
    }
}

async fn transcript_doc(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Document>> {
    let Some((title, created)) = sqlx::query_as::<_, (String, String)>(
        "SELECT title, CAST(created_at AS TEXT) FROM meetings WHERE id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };
    let lines: Vec<(String, Option<f64>, Option<f64>, Option<String>)> = sqlx::query_as(
        "SELECT transcript, audio_start_time, audio_end_time, speaker FROM transcripts
         WHERE meeting_id = ? ORDER BY COALESCE(audio_start_time, 0), rowid",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;
    let mut segments: Vec<Segment> = lines
        .into_iter()
        .filter(|(text, ..)| !text.trim().is_empty())
        .map(|(text, start, end, speaker)| Segment {
            text: match speaker.filter(|s| !s.trim().is_empty()) {
                Some(speaker) => format!("{speaker}: {}", text.trim()),
                None => text.trim().to_string(),
            },
            heading: None,
            start,
            end,
        })
        .collect();
    // So a meeting without transcript lines can still be found by its title.
    if segments.is_empty() {
        segments.push(Segment { text: title.clone(), ..Default::default() });
    }
    Ok(Some(doc(KIND_TRANSCRIPT, title, meeting_id, Some(created), json!({ "meetingId": meeting_id }), segments)))
}

async fn summary_doc(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Document>> {
    let Some(markdown_text) = JournalRepository::summary_markdown(pool, meeting_id).await? else { return Ok(None) };
    let Some((title, created)) = sqlx::query_as::<_, (String, String)>(
        "SELECT title, CAST(created_at AS TEXT) FROM meetings WHERE id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };
    let segments = markdown::segments(&markdown_text);
    Ok(Some(doc(KIND_SUMMARY, title, meeting_id, Some(created), json!({ "meetingId": meeting_id }), segments)))
}

fn journal_doc(id: &str, title: &str, description: Option<&str>, overview: Option<&str>, color: &str) -> Document {
    let mut segments: Vec<Segment> = description
        .filter(|d| !d.trim().is_empty())
        .map(|d| Segment { text: d.trim().to_string(), ..Default::default() })
        .into_iter()
        .collect();
    segments.extend(overview.map(markdown::segments).unwrap_or_default());
    if segments.is_empty() {
        segments.push(Segment { text: title.to_string(), ..Default::default() });
    }
    doc(KIND_JOURNAL, title.to_string(), id, None, json!({ "notebookId": id, "color": color }), segments)
}

async fn note_doc(pool: &SqlitePool, entry_id: &str) -> Result<Option<Document>> {
    let row: Option<(String, String, String, String, Option<String>, Option<f64>, String, String, String)> =
        sqlx::query_as(
            "SELECT e.notebook_id, n.title, e.title, e.summary, e.key_points, e.start_time,
                    e.meeting_id, m.title, CAST(m.created_at AS TEXT)
             FROM notebook_entries e JOIN notebooks n ON n.id = e.notebook_id JOIN meetings m ON m.id = e.meeting_id
             WHERE e.id = ? AND e.status = 'filed'",
        )
        .bind(entry_id)
        .fetch_optional(pool)
        .await?;
    let Some((notebook_id, notebook_title, title, summary, key_points, start, meeting_id, meeting_title, date)) = row
    else {
        return Ok(None);
    };
    // The journal's title as heading: it ranks above body text.
    let heading = Some(notebook_title.clone());
    let mut segments = vec![Segment { text: summary, heading: heading.clone(), start, end: None }];
    let points: Vec<String> = key_points.and_then(|k| serde_json::from_str(&k).ok()).unwrap_or_default();
    if !points.is_empty() {
        let text = points.iter().map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n");
        segments.push(Segment { text, heading, start: None, end: None });
    }
    let meta = json!({
        "notebookId": notebook_id,
        "notebookTitle": notebook_title,
        "entryId": entry_id,
        "meetingId": meeting_id,
        "meetingTitle": meeting_title,
    });
    Ok(Some(doc(KIND_JOURNAL_NOTE, title, &notebook_id, Some(date), meta, segments)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use riff_search::Query;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn search(index: &Index, text: &str, kinds: &[&str]) -> Vec<riff_search::Hit> {
        index
            .search(&Query {
                text: text.into(),
                scopes: vec![SCOPE.into()],
                kinds: kinds.iter().map(|k| k.to_string()).collect(),
                limit: 10,
                grouped: true,
            })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn indexes_meetings_summaries_and_journals_and_follows_changes() {
        let pool = pool().await;
        let index = Index::open_in_memory().await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO meetings (id, title, created_at, updated_at) VALUES ('m1', 'Pricing review', '2026-10-01', '2026-10-01');
             INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time) VALUES
                ('t1', 'm1', 'We should raise the enterprise tier.', '10:00', 12.5);
             INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result) VALUES
                ('m1', 'completed', 'x', 'u1', '{\"markdown\": \"# Decisions\\n\\nEnterprise goes to forty dollars.\"}');
             INSERT INTO notebooks (id, title, description, color, created_at, updated_at) VALUES
                ('n1', 'Pricing', 'What we charge', 'blue', 'x', 'x');
             INSERT INTO notebook_entries (id, notebook_id, meeting_id, title, summary, key_points, created_at) VALUES
                ('e1', 'n1', 'm1', 'Enterprise tier', 'Raise it next quarter.', '[\"forty dollars\"]', 'x');",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(sync_all(&index, &pool).await.unwrap(), 4);
        assert_eq!(sync_all(&index, &pool).await.unwrap(), 0, "nothing changed");

        let meetings = search(&index, "enterprise", &[KIND_TRANSCRIPT, KIND_SUMMARY]).await;
        assert_eq!(meetings.len(), 1, "one result per meeting");
        assert_eq!(meetings[0].group, "m1");
        assert_eq!(meetings[0].also.len(), 1, "transcript and summary both matched");
        let transcript = std::iter::once(&meetings[0]).chain(&meetings[0].also).find(|h| h.kind == KIND_TRANSCRIPT).unwrap();
        assert_eq!(transcript.start, Some(12.5));

        let journals = search(&index, "forty dollars", &[KIND_JOURNAL, KIND_JOURNAL_NOTE]).await;
        assert_eq!(journals[0].group, "n1");
        assert_eq!(journals[0].meta["entryId"], "e1");

        // Retitle, add a line, delete the journal.
        sqlx::raw_sql(
            "UPDATE meetings SET title = 'Packaging review' WHERE id = 'm1';
             INSERT INTO transcripts (id, meeting_id, transcript, timestamp) VALUES ('t2', 'm1', 'Also bundles.', '10:01');
             DELETE FROM notebook_entries; DELETE FROM notebooks;",
        )
        .execute(&pool)
        .await
        .unwrap();
        sync_all(&index, &pool).await.unwrap();
        assert_eq!(search(&index, "bundles", &[]).await.len(), 1);
        assert_eq!(search(&index, "packaging", &[]).await[0].title, "Packaging review");
        assert!(search(&index, "forty", &[KIND_JOURNAL, KIND_JOURNAL_NOTE]).await.is_empty());
    }
}
