//! SQLite access for notebooks, notebook entries and per-meeting organizer status.

use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::collections::HashMap;
use uuid::Uuid;

/// Notebook cover colors, assigned round-robin to new notebooks.
pub const NOTEBOOK_COLORS: &[&str] = &[
    "indigo", "emerald", "amber", "rose", "sky", "violet", "teal", "orange", "slate", "pink",
];

#[derive(Debug, Clone, FromRow, Serialize, Deserialize)]
pub struct Notebook {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub color: String,
    pub auto_created: bool,
    pub summary_markdown: Option<String>,
    pub summary_updated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// True when the journal is about building or changing software; None until classified.
    pub is_software: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NotebookOverview {
    #[serde(flatten)]
    pub notebook: Notebook,
    pub entry_count: i64,
    pub meeting_count: i64,
    /// Most recent meeting date with an entry in this notebook (RFC 3339).
    pub last_meeting_at: Option<String>,
    /// Titles of the latest few entries, for the notebook cover.
    pub recent_entry_titles: Vec<String>,
    /// True when entries were added after the stored summary was written.
    pub summary_stale: bool,
}

/// A journal the organizer suggests for a part it wasn't sure about. `notebook_id`
/// is `None` for a journal that doesn't exist yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Suggestion {
    pub notebook_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
struct EntryRow {
    id: String,
    notebook_id: Option<String>,
    meeting_id: String,
    title: String,
    summary: String,
    key_points: Option<String>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    created_at: String,
    meeting_title: String,
    meeting_created_at: String,
    meeting_duration: Option<f64>,
    status: String,
    confidence: Option<f64>,
    question: Option<String>,
    suggestions: Option<String>,
    notebook_title: Option<String>,
    notebook_color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NotebookEntry {
    pub id: String,
    /// `None` while the part waits for the user to pick a journal.
    pub notebook_id: Option<String>,
    pub meeting_id: String,
    pub title: String,
    pub summary: String,
    pub key_points: Vec<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub created_at: String,
    pub meeting_title: String,
    /// When the meeting was saved (RFC 3339).
    pub meeting_date: String,
    /// Estimated wall-clock start of the recording (RFC 3339): save time minus
    /// recording length. Add `start_time` seconds to get when a topic came up.
    pub meeting_started_at: String,
    /// "filed", or "needs_review" when the organizer wants the user to decide.
    pub status: String,
    pub confidence: Option<f64>,
    pub question: Option<String>,
    pub suggestions: Vec<Suggestion>,
    pub notebook_title: Option<String>,
    pub notebook_color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingJournalStatus {
    pub meeting_id: String,
    pub meeting_title: String,
    pub meeting_date: String,
    pub status: String,
    pub error: Option<String>,
    pub entry_count: i64,
    pub review_count: i64,
}

/// A journal a meeting was filed into, for tagging meetings in lists.
#[derive(Debug, Clone, Serialize)]
pub struct MeetingJournalTag {
    pub meeting_id: String,
    pub notebook_id: String,
    pub title: String,
    pub color: String,
}

#[derive(Debug, Clone)]
pub struct TranscriptLine {
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct MeetingInfo {
    pub id: String,
    pub title: String,
    pub date: String,
    pub started_at: String,
}

pub struct NewEntry {
    pub notebook_id: Option<String>,
    pub meeting_id: String,
    pub title: String,
    pub summary: String,
    pub key_points: Vec<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub status: &'static str,
    pub confidence: Option<f64>,
    pub question: Option<String>,
    pub suggestions: Vec<Suggestion>,
}

pub const STATUS_FILED: &str = "filed";
pub const STATUS_NEEDS_REVIEW: &str = "needs_review";

/// Normalizes the timestamp formats sqlx and older rows have written into RFC 3339.
pub fn normalize_timestamp(raw: &str) -> String {
    parse_timestamp(raw)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| raw.to_string())
}

pub fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f%:z", "%Y-%m-%d %H:%M:%S%.f%z"] {
        if let Ok(dt) = DateTime::parse_from_str(raw, fmt) {
            return Some(dt.with_timezone(&Utc));
        }
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(raw, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc));
        }
    }
    None
}

fn started_at(saved_at: &str, duration: Option<f64>) -> String {
    match (parse_timestamp(saved_at), duration) {
        (Some(dt), Some(secs)) if secs > 0.0 => {
            (dt - chrono::Duration::milliseconds((secs * 1000.0) as i64)).to_rfc3339()
        }
        (Some(dt), _) => dt.to_rfc3339(),
        _ => saved_at.to_string(),
    }
}

impl From<EntryRow> for NotebookEntry {
    fn from(row: EntryRow) -> Self {
        let key_points = row
            .key_points
            .as_deref()
            .and_then(|k| serde_json::from_str::<Vec<String>>(k).ok())
            .unwrap_or_default();
        let suggestions = row
            .suggestions
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<Suggestion>>(s).ok())
            .unwrap_or_default();
        NotebookEntry {
            status: row.status,
            confidence: row.confidence,
            question: row.question,
            suggestions,
            notebook_title: row.notebook_title,
            notebook_color: row.notebook_color,
            meeting_date: normalize_timestamp(&row.meeting_created_at),
            meeting_started_at: started_at(&row.meeting_created_at, row.meeting_duration),
            id: row.id,
            notebook_id: row.notebook_id,
            meeting_id: row.meeting_id,
            title: row.title,
            summary: row.summary,
            key_points,
            start_time: row.start_time,
            end_time: row.end_time,
            created_at: row.created_at,
            meeting_title: row.meeting_title,
        }
    }
}

const ENTRY_SELECT: &str = "SELECT e.id, e.notebook_id, e.meeting_id, e.title, e.summary, e.key_points,
        e.start_time, e.end_time, e.created_at, e.status, e.confidence, e.question, e.suggestions,
        n.title AS notebook_title, n.color AS notebook_color,
        m.title AS meeting_title, CAST(m.created_at AS TEXT) AS meeting_created_at,
        (SELECT MAX(COALESCE(t.audio_end_time, t.audio_start_time)) FROM transcripts t WHERE t.meeting_id = m.id) AS meeting_duration
     FROM notebook_entries e
     JOIN meetings m ON m.id = e.meeting_id
     LEFT JOIN notebooks n ON n.id = e.notebook_id";

pub struct JournalRepository;

impl JournalRepository {
    pub async fn list_notebooks(pool: &SqlitePool) -> Result<Vec<Notebook>, sqlx::Error> {
        sqlx::query_as::<_, Notebook>("SELECT * FROM notebooks ORDER BY updated_at DESC")
            .fetch_all(pool)
            .await
    }

    pub async fn get_notebook(pool: &SqlitePool, id: &str) -> Result<Option<Notebook>, sqlx::Error> {
        sqlx::query_as::<_, Notebook>("SELECT * FROM notebooks WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
    }

    pub async fn list_overviews(pool: &SqlitePool) -> Result<Vec<NotebookOverview>, sqlx::Error> {
        let notebooks = Self::list_notebooks(pool).await?;
        let entries = Self::list_entries(pool, None).await?;

        let mut by_notebook: HashMap<&str, Vec<&NotebookEntry>> = HashMap::new();
        for entry in &entries {
            if let Some(notebook_id) = entry.notebook_id.as_deref() {
                by_notebook.entry(notebook_id).or_default().push(entry);
            }
        }

        let mut overviews: Vec<NotebookOverview> = notebooks
            .into_iter()
            .map(|notebook| {
                let entries = by_notebook.remove(notebook.id.as_str()).unwrap_or_default();
                let mut meetings: Vec<&str> = entries.iter().map(|e| e.meeting_id.as_str()).collect();
                meetings.sort_unstable();
                meetings.dedup();
                let last_meeting_at = entries.iter().map(|e| e.meeting_date.clone()).max();
                let latest_entry = entries.iter().map(|e| e.created_at.as_str()).max();
                let summary_stale = match (&notebook.summary_updated_at, latest_entry) {
                    (Some(summary_at), Some(latest)) => latest > summary_at.as_str(),
                    _ => false,
                };
                NotebookOverview {
                    entry_count: entries.len() as i64,
                    meeting_count: meetings.len() as i64,
                    recent_entry_titles: entries.iter().take(3).map(|e| e.title.clone()).collect(),
                    last_meeting_at,
                    summary_stale,
                    notebook,
                }
            })
            .collect();

        // Most recently discussed topics first.
        overviews.sort_by(|a, b| {
            b.last_meeting_at
                .cmp(&a.last_meeting_at)
                .then_with(|| b.notebook.updated_at.cmp(&a.notebook.updated_at))
        });
        Ok(overviews)
    }

    /// Filed entries, newest meeting first and in recording order within a meeting.
    pub async fn list_entries(
        pool: &SqlitePool,
        notebook_id: Option<&str>,
    ) -> Result<Vec<NotebookEntry>, sqlx::Error> {
        let order = " ORDER BY m.created_at DESC, COALESCE(e.start_time, 0) ASC";
        let rows = match notebook_id {
            Some(id) => {
                sqlx::query_as::<_, EntryRow>(&format!("{ENTRY_SELECT} WHERE e.status = 'filed' AND e.notebook_id = ?{order}"))
                    .bind(id)
                    .fetch_all(pool)
                    .await?
            }
            None => {
                sqlx::query_as::<_, EntryRow>(&format!("{ENTRY_SELECT} WHERE e.status = 'filed'{order}"))
                    .fetch_all(pool)
                    .await?
            }
        };
        Ok(rows.into_iter().map(NotebookEntry::from).collect())
    }

    /// Parts waiting for the user to pick a journal, newest meeting first.
    pub async fn list_review_entries(pool: &SqlitePool) -> Result<Vec<NotebookEntry>, sqlx::Error> {
        let rows = sqlx::query_as::<_, EntryRow>(&format!(
            "{ENTRY_SELECT} WHERE e.status = 'needs_review' ORDER BY m.created_at DESC, COALESCE(e.start_time, 0) ASC"
        ))
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(NotebookEntry::from).collect())
    }

    /// Every part of one meeting, filed or not, in recording order.
    pub async fn list_meeting_entries(pool: &SqlitePool, meeting_id: &str) -> Result<Vec<NotebookEntry>, sqlx::Error> {
        let rows = sqlx::query_as::<_, EntryRow>(&format!(
            "{ENTRY_SELECT} WHERE e.meeting_id = ? ORDER BY COALESCE(e.start_time, 0) ASC"
        ))
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;
        Ok(rows.into_iter().map(NotebookEntry::from).collect())
    }

    pub async fn entry_meeting_id(pool: &SqlitePool, entry_id: &str) -> Result<Option<String>, sqlx::Error> {
        let row: Option<(String,)> = sqlx::query_as("SELECT meeting_id FROM notebook_entries WHERE id = ?")
            .bind(entry_id)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(|r| r.0))
    }

    pub async fn count_review_entries(pool: &SqlitePool, meeting_id: &str) -> Result<i64, sqlx::Error> {
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM notebook_entries WHERE meeting_id = ? AND status = 'needs_review'",
        )
        .bind(meeting_id)
        .fetch_one(pool)
        .await?;
        Ok(row.0)
    }

    pub async fn create_notebook(
        pool: &SqlitePool,
        title: &str,
        description: Option<&str>,
        auto_created: bool,
    ) -> Result<Notebook, sqlx::Error> {
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM notebooks")
            .fetch_one(pool)
            .await?;
        let color = NOTEBOOK_COLORS[(count.0 as usize) % NOTEBOOK_COLORS.len()];
        let now = Utc::now().to_rfc3339();
        let notebook = Notebook {
            id: format!("notebook-{}", Uuid::new_v4()),
            title: title.trim().to_string(),
            description: description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()),
            color: color.to_string(),
            auto_created,
            summary_markdown: None,
            summary_updated_at: None,
            created_at: now.clone(),
            updated_at: now,
            is_software: None,
        };
        sqlx::query(
            "INSERT INTO notebooks (id, title, description, color, auto_created, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&notebook.id)
        .bind(&notebook.title)
        .bind(&notebook.description)
        .bind(&notebook.color)
        .bind(notebook.auto_created)
        .bind(&notebook.created_at)
        .bind(&notebook.updated_at)
        .execute(pool)
        .await?;
        Ok(notebook)
    }

    pub async fn update_notebook(
        pool: &SqlitePool,
        id: &str,
        title: Option<&str>,
        description: Option<&str>,
        color: Option<&str>,
    ) -> Result<bool, sqlx::Error> {
        // A notebook the user has edited is theirs: never prune it automatically.
        let result = sqlx::query(
            "UPDATE notebooks SET
                title = COALESCE(?, title),
                description = COALESCE(?, description),
                color = COALESCE(?, color),
                auto_created = 0,
                updated_at = ?
             WHERE id = ?",
        )
        .bind(title.map(str::trim).filter(|t| !t.is_empty()))
        .bind(description.map(str::trim))
        .bind(color)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn touch_notebook(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE notebooks SET updated_at = ? WHERE id = ?")
            .bind(Utc::now().to_rfc3339())
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn delete_notebook(pool: &SqlitePool, id: &str) -> Result<bool, sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM notebook_entries WHERE notebook_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query("DELETE FROM notebooks WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    /// Moves every entry of `source_id` into `target_id` and deletes the source.
    pub async fn merge_notebooks(
        pool: &SqlitePool,
        source_id: &str,
        target_id: &str,
    ) -> Result<(), sqlx::Error> {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE notebook_entries SET notebook_id = ? WHERE notebook_id = ?")
            .bind(target_id)
            .bind(source_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM notebooks WHERE id = ?")
            .bind(source_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE notebooks SET updated_at = ? WHERE id = ?")
            .bind(Utc::now().to_rfc3339())
            .bind(target_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }

    /// Files an entry into a journal, which also settles a part that was waiting for review.
    pub async fn move_entry(pool: &SqlitePool, entry_id: &str, notebook_id: &str) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE notebook_entries SET notebook_id = ?, status = 'filed', question = NULL, suggestions = NULL WHERE id = ?",
        )
            .bind(notebook_id)
            .bind(entry_id)
            .execute(pool)
            .await?;
        Self::touch_notebook(pool, notebook_id).await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn delete_entry(pool: &SqlitePool, entry_id: &str) -> Result<bool, sqlx::Error> {
        let result = sqlx::query("DELETE FROM notebook_entries WHERE id = ?")
            .bind(entry_id)
            .execute(pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn insert_entry(pool: &SqlitePool, entry: &NewEntry) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO notebook_entries
                (id, notebook_id, meeting_id, title, summary, key_points, start_time, end_time, created_at,
                 status, confidence, question, suggestions)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(format!("entry-{}", Uuid::new_v4()))
        .bind(&entry.notebook_id)
        .bind(&entry.meeting_id)
        .bind(&entry.title)
        .bind(&entry.summary)
        .bind(serde_json::to_string(&entry.key_points).unwrap_or_else(|_| "[]".into()))
        .bind(entry.start_time)
        .bind(entry.end_time)
        .bind(Utc::now().to_rfc3339())
        .bind(entry.status)
        .bind(entry.confidence)
        .bind(&entry.question)
        .bind(if entry.suggestions.is_empty() {
            None
        } else {
            serde_json::to_string(&entry.suggestions).ok()
        })
        .execute(pool)
        .await?;
        match &entry.notebook_id {
            Some(id) => Self::touch_notebook(pool, id).await,
            None => Ok(()),
        }
    }

    pub async fn delete_entries_for_meeting(pool: &SqlitePool, meeting_id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM notebook_entries WHERE meeting_id = ?")
            .bind(meeting_id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// Deletes organizer-created notebooks left without entries.
    pub async fn prune_empty_auto_notebooks(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        sqlx::query(
            "DELETE FROM notebooks WHERE auto_created = 1
             AND NOT EXISTS (SELECT 1 FROM notebook_entries e WHERE e.notebook_id = notebooks.id)",
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_summary(pool: &SqlitePool, id: &str, markdown: &str) -> Result<String, sqlx::Error> {
        let now = Utc::now().to_rfc3339();
        sqlx::query("UPDATE notebooks SET summary_markdown = ?, summary_updated_at = ? WHERE id = ?")
            .bind(markdown)
            .bind(&now)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(now)
    }

    pub async fn set_is_software(pool: &SqlitePool, id: &str, is_software: bool) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE notebooks SET is_software = ? WHERE id = ?")
            .bind(is_software)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_status(
        pool: &SqlitePool,
        meeting_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO journal_meeting_status (meeting_id, status, error, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(meeting_id) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = excluded.updated_at",
        )
        .bind(meeting_id)
        .bind(status)
        .bind(error)
        .bind(Utc::now().to_rfc3339())
        .execute(pool)
        .await?;
        Ok(())
    }

    /// Every meeting with its organizer status; meetings never organized report "unfiled".
    pub async fn list_meeting_statuses(pool: &SqlitePool) -> Result<Vec<MeetingJournalStatus>, sqlx::Error> {
        let rows: Vec<(String, String, String, Option<String>, Option<String>, i64, i64)> = sqlx::query_as(
            "SELECT m.id, m.title, CAST(m.created_at AS TEXT), s.status, s.error,
                    (SELECT COUNT(*) FROM notebook_entries e WHERE e.meeting_id = m.id AND e.status = 'filed'),
                    (SELECT COUNT(*) FROM notebook_entries e WHERE e.meeting_id = m.id AND e.status = 'needs_review')
             FROM meetings m
             LEFT JOIN journal_meeting_status s ON s.meeting_id = m.id
             ORDER BY m.created_at DESC",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(id, title, created, status, error, entry_count, review_count)| MeetingJournalStatus {
                meeting_id: id,
                meeting_title: title,
                meeting_date: normalize_timestamp(&created),
                status: status.unwrap_or_else(|| "unfiled".into()),
                error,
                entry_count,
                review_count,
            })
            .collect())
    }

    pub async fn meeting_journal_tags(pool: &SqlitePool) -> Result<Vec<MeetingJournalTag>, sqlx::Error> {
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT e.meeting_id, n.id, n.title, n.color FROM notebook_entries e
             JOIN notebooks n ON n.id = e.notebook_id
             WHERE e.status = 'filed'
             GROUP BY e.meeting_id, n.id
             ORDER BY MIN(COALESCE(e.start_time, 0))",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(meeting_id, notebook_id, title, color)| MeetingJournalTag { meeting_id, notebook_id, title, color })
            .collect())
    }

    pub async fn get_meeting_info(pool: &SqlitePool, meeting_id: &str) -> Result<Option<MeetingInfo>, sqlx::Error> {
        let row: Option<(String, String, String, Option<f64>)> = sqlx::query_as(
            "SELECT m.id, m.title, CAST(m.created_at AS TEXT),
                    (SELECT MAX(COALESCE(t.audio_end_time, t.audio_start_time)) FROM transcripts t WHERE t.meeting_id = m.id)
             FROM meetings m WHERE m.id = ?",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;
        Ok(row.map(|(id, title, created, duration)| MeetingInfo {
            id,
            title,
            date: normalize_timestamp(&created),
            started_at: started_at(&created, duration),
        }))
    }

    /// The meeting's summary process status, if a summary was ever started.
    pub async fn summary_status(pool: &SqlitePool, meeting_id: &str) -> Result<Option<String>, sqlx::Error> {
        let row: Option<(String,)> = sqlx::query_as("SELECT status FROM summary_processes WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_optional(pool)
            .await?;
        Ok(row.map(|r| r.0))
    }

    /// The meeting's completed AI summary as Markdown, if there is one.
    pub async fn summary_markdown(pool: &SqlitePool, meeting_id: &str) -> Result<Option<String>, sqlx::Error> {
        let row: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT result FROM summary_processes WHERE meeting_id = ? AND status = 'completed'",
        )
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;
        Ok(row
            .and_then(|r| r.0)
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
            .and_then(|value| value.get("markdown").and_then(|m| m.as_str()).map(str::to_string))
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()))
    }

    pub async fn get_transcript_lines(pool: &SqlitePool, meeting_id: &str) -> Result<Vec<TranscriptLine>, sqlx::Error> {
        let rows: Vec<(String, Option<f64>, Option<f64>)> = sqlx::query_as(
            "SELECT transcript, audio_start_time, audio_end_time FROM transcripts
             WHERE meeting_id = ? ORDER BY COALESCE(audio_start_time, 0), rowid",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter(|(text, _, _)| !text.trim().is_empty())
            .map(|(text, start, end)| TranscriptLine { text: text.trim().to_string(), start, end })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::repositories::meeting::MeetingsRepository;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let now = Utc::now();
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES ('m1', 'Standup', ?, ?)")
            .bind(now)
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();
        for (i, (text, start)) in [("We cut the budget by ten percent.", 5.0), ("Sam owns hiring.", 600.0)].iter().enumerate() {
            sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time)
                 VALUES (?, 'm1', ?, '10:00:00', ?, ?)",
            )
            .bind(format!("t{i}"))
            .bind(text)
            .bind(start)
            .bind(start + 4.0)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn notebooks_entries_and_meeting_deletion() {
        let pool = test_pool().await;
        let lines = JournalRepository::get_transcript_lines(&pool, "m1").await.unwrap();
        assert_eq!(lines.len(), 2);

        let info = JournalRepository::get_meeting_info(&pool, "m1").await.unwrap().unwrap();
        let saved = parse_timestamp(&info.date).expect("meeting date parses");
        let started = parse_timestamp(&info.started_at).unwrap();
        assert_eq!((saved - started).num_seconds(), 604);

        let budget = JournalRepository::create_notebook(&pool, "Budget", Some("Spend"), true).await.unwrap();
        let mine = JournalRepository::create_notebook(&pool, "Mine", None, false).await.unwrap();
        JournalRepository::insert_entry(
            &pool,
            &NewEntry {
                notebook_id: Some(budget.id.clone()),
                meeting_id: "m1".into(),
                title: "Cuts".into(),
                summary: "Budget cut 10%.".into(),
                key_points: vec!["10% cut".into()],
                start_time: Some(5.0),
                end_time: Some(9.0),
                status: STATUS_FILED,
                confidence: Some(0.9),
                question: None,
                suggestions: vec![],
            },
        )
        .await
        .unwrap();

        let overviews = JournalRepository::list_overviews(&pool).await.unwrap();
        assert_eq!(overviews[0].notebook.id, budget.id);
        assert_eq!(overviews[0].entry_count, 1);
        assert_eq!(overviews[0].recent_entry_titles, vec!["Cuts".to_string()]);

        let entries = JournalRepository::list_entries(&pool, Some(&budget.id)).await.unwrap();
        assert_eq!(entries[0].key_points, vec!["10% cut".to_string()]);
        assert_eq!(entries[0].meeting_title, "Standup");

        // A part the organizer wasn't sure about stays out of journals until the user picks one.
        JournalRepository::insert_entry(
            &pool,
            &NewEntry {
                notebook_id: None,
                meeting_id: "m1".into(),
                title: "Hiring".into(),
                summary: "Sam owns hiring.".into(),
                key_points: vec![],
                start_time: Some(600.0),
                end_time: Some(604.0),
                status: STATUS_NEEDS_REVIEW,
                confidence: Some(0.4),
                question: Some("Budget or a new Hiring journal?".into()),
                suggestions: vec![Suggestion { notebook_id: None, title: "Hiring".into(), description: None }],
            },
        )
        .await
        .unwrap();
        let review = JournalRepository::list_review_entries(&pool).await.unwrap();
        assert_eq!(review.len(), 1);
        assert_eq!(review[0].suggestions[0].title, "Hiring");
        assert_eq!(JournalRepository::list_entries(&pool, None).await.unwrap().len(), 1);
        assert_eq!(JournalRepository::count_review_entries(&pool, "m1").await.unwrap(), 1);
        let statuses = JournalRepository::list_meeting_statuses(&pool).await.unwrap();
        assert_eq!(statuses[0].review_count, 1);

        JournalRepository::move_entry(&pool, &review[0].id, &mine.id).await.unwrap();
        assert_eq!(JournalRepository::count_review_entries(&pool, "m1").await.unwrap(), 0);
        let parts = JournalRepository::list_meeting_entries(&pool, "m1").await.unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1].notebook_title.as_deref(), Some("Mine"));
        JournalRepository::delete_entry(&pool, &parts[1].id).await.unwrap();

        JournalRepository::set_status(&pool, "m1", "completed", None).await.unwrap();
        let statuses = JournalRepository::list_meeting_statuses(&pool).await.unwrap();
        assert_eq!((statuses[0].status.as_str(), statuses[0].entry_count), ("completed", 1));

        // Deleting the meeting removes its entries and the now-empty auto notebook,
        // but keeps the notebook the user created.
        MeetingsRepository::delete_meeting(&pool, "m1").await.unwrap();
        let remaining: Vec<String> = JournalRepository::list_notebooks(&pool).await.unwrap().into_iter().map(|n| n.id).collect();
        assert_eq!(remaining, vec![mine.id]);
    }
}
