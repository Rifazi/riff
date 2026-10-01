//! Journal orchestration: files each part of a meeting into the topic journal it
//! belongs in (asking the user when unsure), compiles journal overviews, and
//! answers questions from a journal's meetings.

use super::llm::{extract_json_object, JournalLlm};
use super::repository::{
    parse_timestamp, JournalRepository, MeetingInfo, MeetingJournalStatus, NewEntry, Notebook, NotebookEntry,
    NotebookOverview, Suggestion, TranscriptLine, STATUS_FILED, STATUS_NEEDS_REVIEW,
};
use crate::state::AppState;
use chrono::Local;
use log::{info, warn};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Emitted whenever a meeting's journal status changes or notebooks change.
pub const JOURNAL_UPDATED_EVENT: &str = "journal-updated";

/// Organizing is serialized so two meetings filed at once can't both create
/// the same new notebook.
static ORGANIZE_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// Meetings queued or being filed in this app run. A stored "pending" or
/// "processing" status for a meeting not in here is left over from a previous run.
static ACTIVE: Lazy<std::sync::Mutex<HashSet<String>>> = Lazy::new(|| std::sync::Mutex::new(HashSet::new()));

/// Transcripts shorter than this are not worth filing.
const MIN_TRANSCRIPT_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct JournalUpdatedPayload {
    pub meeting_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
}

pub fn emit_updated<R: Runtime>(app: &AppHandle<R>, meeting_id: Option<&str>, status: &str, error: Option<&str>) {
    let _ = app.emit(
        JOURNAL_UPDATED_EVENT,
        JournalUpdatedPayload {
            meeting_id: meeting_id.map(str::to_string),
            status: status.to_string(),
            error: error.map(str::to_string),
        },
    );
}

pub fn pool_from_app<R: Runtime>(app: &AppHandle<R>) -> Result<SqlitePool, String> {
    app.try_state::<AppState>()
        .map(|state| state.db_manager.pool().clone())
        .ok_or_else(|| "Database is not initialized yet".to_string())
}

// ---------------------------------------------------------------------------
// Organizing meetings into journals
// ---------------------------------------------------------------------------

/// How long a newly saved meeting waits for its AI summary to start before it
/// is filed from the transcript alone (auto-summary off, or no model set up).
const SUMMARY_START_GRACE: Duration = Duration::from_secs(60);
/// Upper bound on waiting for a running summary.
const SUMMARY_MAX_WAIT: Duration = Duration::from_secs(20 * 60);
/// Parts the organizer is less sure about than this wait for the user to pick a journal.
pub const CONFIDENCE_THRESHOLD: f64 = 0.6;
/// Used when the model doesn't report a confidence.
const DEFAULT_CONFIDENCE: f64 = 0.8;
const MAX_SUGGESTIONS: usize = 4;

fn mark_active(meeting_id: &str) -> bool {
    ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).insert(meeting_id.to_string())
}

fn unmark_active(meeting_id: &str) {
    ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).remove(meeting_id);
}

/// Called when a meeting is saved. Recording → summary → journals: waits for the
/// meeting's AI summary, then files the meeting using it.
pub fn spawn_after_summary<R: Runtime>(app: AppHandle<R>, meeting_id: String) {
    if !mark_active(&meeting_id) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Ok(pool) = pool_from_app(&app) {
            let _ = JournalRepository::set_status(&pool, &meeting_id, "awaiting_summary", None).await;
            emit_updated(&app, Some(&meeting_id), "awaiting_summary", None);
            wait_for_summary(&pool, &meeting_id).await;
        }
        organize_with_status(&app, &meeting_id).await;
        unmark_active(&meeting_id);
    });
}

async fn wait_for_summary(pool: &SqlitePool, meeting_id: &str) {
    let started = Instant::now();
    loop {
        let status = JournalRepository::summary_status(pool, meeting_id).await.ok().flatten();
        match status.as_deref() {
            Some("completed" | "failed" | "error" | "cancelled") => return,
            Some(_) if started.elapsed() > SUMMARY_MAX_WAIT => {
                warn!("Journal: summary for {meeting_id} still running after {SUMMARY_MAX_WAIT:?}; filing without it");
                return;
            }
            None if started.elapsed() > SUMMARY_START_GRACE => {
                info!("Journal: no summary started for {meeting_id}; filing from the transcript");
                return;
            }
            _ => tokio::time::sleep(Duration::from_secs(3)).await,
        }
    }
}

/// Files (or re-files) a meeting now, using its summary if it has one.
pub fn spawn_organize<R: Runtime>(app: AppHandle<R>, meeting_id: String) {
    if !mark_active(&meeting_id) {
        return; // already queued
    }
    tauri::async_runtime::spawn(async move {
        organize_with_status(&app, &meeting_id).await;
        unmark_active(&meeting_id);
    });
}

/// Meeting statuses with leftovers from an interrupted run reported as "unfiled".
pub async fn meeting_statuses(pool: &SqlitePool) -> Result<Vec<MeetingJournalStatus>, String> {
    let mut statuses = JournalRepository::list_meeting_statuses(pool)
        .await
        .map_err(|e| e.to_string())?;
    let active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    for status in &mut statuses {
        let in_flight = matches!(status.status.as_str(), "pending" | "processing" | "awaiting_summary");
        if in_flight && !active.contains(&status.meeting_id) {
            status.status = "unfiled".into();
        }
    }
    Ok(statuses)
}

pub async fn organize_with_status<R: Runtime>(app: &AppHandle<R>, meeting_id: &str) {
    let pool = match pool_from_app(app) {
        Ok(pool) => pool,
        Err(e) => {
            warn!("Journal: cannot organize {meeting_id}: {e}");
            return;
        }
    };

    let _ = JournalRepository::set_status(&pool, meeting_id, "pending", None).await;
    emit_updated(app, Some(meeting_id), "pending", None);

    let _guard = ORGANIZE_LOCK.lock().await;
    let _ = JournalRepository::set_status(&pool, meeting_id, "processing", None).await;
    emit_updated(app, Some(meeting_id), "processing", None);

    let mut touched = Vec::new();
    let (status, error) = match organize_meeting(app, &pool, meeting_id).await {
        Ok(OrganizeOutcome::Filed { filed, review, notebooks }) => {
            info!("Journal: filed meeting {meeting_id}: {filed} parts filed, {review} waiting for review");
            touched = notebooks;
            if review > 0 { ("needs_review", None) } else { ("completed", None) }
        }
        Ok(OrganizeOutcome::Skipped(reason)) => {
            info!("Journal: skipped meeting {meeting_id}: {reason}");
            ("skipped", Some(reason))
        }
        Err(e) => {
            warn!("Journal: failed to organize meeting {meeting_id}: {e}");
            ("failed", Some(e))
        }
    };
    let _ = JournalRepository::set_status(&pool, meeting_id, status, error.as_deref()).await;
    emit_updated(app, Some(meeting_id), status, error.as_deref());

    // Journals are compiled from their meetings: bring each touched journal's overview up to date.
    compile_journals(app, &pool, &touched).await;
}

/// Re-files a meeting's status after the user settles or discards one of its parts.
pub async fn refresh_meeting_status<R: Runtime>(app: &AppHandle<R>, pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    let remaining = JournalRepository::count_review_entries(pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    let status = if remaining > 0 { "needs_review" } else { "completed" };
    JournalRepository::set_status(pool, meeting_id, status, None)
        .await
        .map_err(|e| e.to_string())?;
    emit_updated(app, Some(meeting_id), status, None);
    Ok(())
}

/// Rebuilds journal overviews in the background, one model call at a time.
pub fn spawn_compile_journals<R: Runtime>(app: AppHandle<R>, notebook_ids: Vec<String>) {
    tauri::async_runtime::spawn(async move {
        let Ok(pool) = pool_from_app(&app) else { return };
        let _guard = ORGANIZE_LOCK.lock().await;
        compile_journals(&app, &pool, &notebook_ids).await;
    });
}

async fn compile_journals<R: Runtime>(app: &AppHandle<R>, pool: &SqlitePool, notebook_ids: &[String]) {
    for notebook_id in notebook_ids {
        match summarize_notebook(app, pool, notebook_id).await {
            Ok(_) => emit_updated(app, None, "notebooks-changed", None),
            Err(e) => warn!("Journal: could not update the overview of {notebook_id}: {e}"),
        }
    }
}

pub enum OrganizeOutcome {
    Filed {
        filed: usize,
        review: usize,
        /// Journals that received filed parts.
        notebooks: Vec<String>,
    },
    Skipped(String),
}

const ORGANIZE_SYSTEM_PROMPT: &str = "You are the librarian of a personal knowledge base built from meetings. \
You file what was discussed into journals. A journal is a durable topic that collects notes from many meetings over time: \
a project, client, product area, initiative, recurring theme or ongoing 1:1 track (for example \"Mobile App Redesign\", \
\"Backend Hiring\", \"Q4 Budget\"). A journal is never a single meeting, a date, or a generic label like \"Meeting Notes\", \
\"Discussion\" or \"General\".\n\
Rules:\n\
- A meeting usually covers several topics. Split it into its discrete parts (usually 1 to 6) and file each part on its own, so each journal gets only the parts about its topic. Ignore greetings, small talk and transcription noise.\n\
- File each part into an existing journal when it fits. Propose a new journal only when nothing existing fits, and never a near-duplicate of an existing one.\n\
- Rate your confidence honestly from 0 to 1. Use 0.9 or more when the part clearly belongs. Go below 0.6 when it could fit more than one journal, \
when you would create a new journal but an existing one might fit, or when the part is too vague to place. The user is asked about low-confidence parts, so never force a fit.\n\
- Write each summary as useful notes: concrete facts, decisions, numbers, names, owners and deadlines. Never invent anything that is not in the meeting.\n\
- Reply with JSON only, no prose.";

/// A part the model found, before journals are created and entries written.
struct DraftTopic {
    notebook: NotebookRef,
    title: String,
    summary: String,
    key_points: Vec<String>,
    start: Option<f64>,
    end: Option<f64>,
    confidence: f64,
    question: Option<String>,
    /// Other journals that could fit, best first.
    alternatives: Vec<NotebookRef>,
}

impl DraftTopic {
    fn needs_review(&self) -> bool {
        self.confidence < CONFIDENCE_THRESHOLD
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum NotebookRef {
    Existing(String),
    /// Index into the journals proposed during this run.
    New(usize),
}

struct ProposedNotebook {
    title: String,
    description: Option<String>,
}

struct TranscriptChunk {
    text: String,
    start: Option<f64>,
    end: Option<f64>,
}

pub async fn organize_meeting<R: Runtime>(
    app: &AppHandle<R>,
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<OrganizeOutcome, String> {
    let meeting = JournalRepository::get_meeting_info(pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Meeting not found")?;
    let lines = JournalRepository::get_transcript_lines(pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?;

    let total_chars: usize = lines.iter().map(|l| l.text.len()).sum();
    if total_chars < MIN_TRANSCRIPT_CHARS {
        clear_meeting_entries(pool, meeting_id).await?;
        return Ok(OrganizeOutcome::Skipped("Transcript is too short to file".into()));
    }

    let llm = JournalLlm::from_settings(app, pool).await?;
    let overviews = JournalRepository::list_overviews(pool).await.map_err(|e| e.to_string())?;
    let notebooks: Vec<Notebook> = overviews.iter().map(|o| o.notebook.clone()).collect();

    // The meeting summary gives the model the big picture; facts and times still come from the transcript.
    let summary_budget = (llm.context_chars() / 5).min(4_000);
    let meeting_summary: Option<String> = JournalRepository::summary_markdown(pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?
        .map(|m| m.chars().take(summary_budget).collect());

    // Leave room for instructions, the journal list and the summary.
    let reserved = 4_000 + meeting_summary.as_ref().map_or(0, |s| s.len());
    let chunk_budget = llm.context_chars().saturating_sub(reserved).max(4_000);
    let chunks = chunk_transcript(&lines, chunk_budget);

    let mut proposed: Vec<ProposedNotebook> = Vec::new();
    let mut drafts: Vec<DraftTopic> = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let prompt = organize_prompt(&meeting, &overviews, &proposed, meeting_summary.as_deref(), chunk, index, chunks.len());
        let reply = llm.complete(ORGANIZE_SYSTEM_PROMPT, &prompt).await?;
        let value = extract_json_object(&reply)
            .ok_or("The AI model did not return valid JSON while organizing this meeting")?;
        drafts.extend(parse_topics(&value, &notebooks, &mut proposed, chunk));
    }

    // Only touch stored entries once every model call succeeded, so a failed
    // re-run leaves the previous filing intact.
    clear_meeting_entries(pool, meeting_id).await?;
    if drafts.is_empty() {
        return Ok(OrganizeOutcome::Skipped("No substantive topics found".into()));
    }

    let merged = merge_drafts(drafts);

    // Create proposed journals only when a confidently filed part needs them;
    // uncertain parts merely suggest them.
    let mut created: HashMap<usize, String> = HashMap::new();
    for (index, notebook) in proposed.iter().enumerate() {
        let used = merged.iter().any(|d| !d.needs_review() && d.notebook == NotebookRef::New(index));
        if used {
            let row = JournalRepository::create_notebook(pool, &notebook.title, notebook.description.as_deref(), true)
                .await
                .map_err(|e| e.to_string())?;
            created.insert(index, row.id);
        }
    }

    let suggestion_for = |reference: &NotebookRef| -> Option<Suggestion> {
        match reference {
            NotebookRef::Existing(id) => notebooks.iter().find(|n| &n.id == id).map(|n| Suggestion {
                notebook_id: Some(n.id.clone()),
                title: n.title.clone(),
                description: n.description.clone(),
            }),
            NotebookRef::New(index) => proposed.get(*index).map(|p| Suggestion {
                notebook_id: created.get(index).cloned(),
                title: p.title.clone(),
                description: p.description.clone(),
            }),
        }
    };

    let (mut filed, mut review) = (0, 0);
    let mut touched: Vec<String> = Vec::new();
    for draft in &merged {
        let (notebook_id, status, suggestions, question) = if draft.needs_review() {
            review += 1;
            let mut suggestions: Vec<Suggestion> = Vec::new();
            for reference in std::iter::once(&draft.notebook).chain(draft.alternatives.iter()) {
                if let Some(s) = suggestion_for(reference) {
                    if !suggestions.contains(&s) && suggestions.len() < MAX_SUGGESTIONS {
                        suggestions.push(s);
                    }
                }
            }
            let question = draft
                .question
                .clone()
                .unwrap_or_else(|| "Which journal does this part belong in?".to_string());
            (None, STATUS_NEEDS_REVIEW, suggestions, Some(question))
        } else {
            filed += 1;
            let id = match &draft.notebook {
                NotebookRef::Existing(id) => id.clone(),
                NotebookRef::New(index) => created[index].clone(),
            };
            if !touched.contains(&id) {
                touched.push(id.clone());
            }
            (Some(id), STATUS_FILED, Vec::new(), None)
        };

        JournalRepository::insert_entry(
            pool,
            &NewEntry {
                notebook_id,
                meeting_id: meeting_id.to_string(),
                title: draft.title.clone(),
                summary: draft.summary.clone(),
                key_points: draft.key_points.clone(),
                start_time: draft.start,
                end_time: draft.end,
                status,
                confidence: Some(draft.confidence),
                question,
                suggestions,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(OrganizeOutcome::Filed { filed, review, notebooks: touched })
}

async fn clear_meeting_entries(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    JournalRepository::delete_entries_for_meeting(pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    JournalRepository::prune_empty_auto_notebooks(pool)
        .await
        .map_err(|e| e.to_string())
}

fn chunk_transcript(lines: &[TranscriptLine], budget: usize) -> Vec<TranscriptChunk> {
    let mut chunks = Vec::new();
    let mut current = TranscriptChunk { text: String::new(), start: None, end: None };
    for line in lines {
        let formatted = match line.start {
            Some(start) => format!("[{}] {}\n", format_offset(start), line.text),
            None => format!("{}\n", line.text),
        };
        if !current.text.is_empty() && current.text.len() + formatted.len() > budget {
            chunks.push(std::mem::replace(
                &mut current,
                TranscriptChunk { text: String::new(), start: None, end: None },
            ));
        }
        current.start = current.start.or(line.start);
        current.end = line.end.or(line.start).or(current.end);
        current.text.push_str(&formatted);
    }
    if !current.text.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn organize_prompt(
    meeting: &MeetingInfo,
    overviews: &[NotebookOverview],
    proposed: &[ProposedNotebook],
    meeting_summary: Option<&str>,
    chunk: &TranscriptChunk,
    index: usize,
    total: usize,
) -> String {
    let mut list = String::new();
    for overview in overviews.iter().take(80) {
        let notebook = &overview.notebook;
        let description: String = notebook.description.as_deref().unwrap_or("").chars().take(160).collect();
        let recent = if overview.recent_entry_titles.is_empty() {
            String::new()
        } else {
            format!(" | recent notes: {}", overview.recent_entry_titles.join("; "))
        };
        list.push_str(&format!("- {} | {} | {}{}\n", notebook.id, notebook.title, description, recent));
    }
    for (i, notebook) in proposed.iter().enumerate() {
        list.push_str(&format!(
            "- new-{} | {} | {}\n",
            i + 1,
            notebook.title,
            notebook.description.as_deref().unwrap_or("")
        ));
    }
    if list.is_empty() {
        list.push_str("(none yet)\n");
    }

    let summary = match meeting_summary {
        Some(summary) => format!(
            "AI summary of the whole meeting (for context; take facts and times from the transcript):\n<summary>\n{summary}\n</summary>\n\n"
        ),
        None => String::new(),
    };
    let part = if total > 1 { format!(" (part {} of {})", index + 1, total) } else { String::new() };
    format!(
        "Existing journals (id | title | description | recent notes):\n{list}\n\
Meeting: \"{title}\", recorded {date}.\n\n{summary}\
Transcript{part}, each line prefixed with [minutes:seconds] into the recording:\n\
<transcript>\n{text}</transcript>\n\n\
Respond with exactly this JSON shape:\n\
{{\"topics\": [{{\"notebook_id\": \"<id of an existing journal, or null for a new one>\", \
\"new_notebook_title\": \"<2-5 word topic name, only when notebook_id is null>\", \
\"new_notebook_description\": \"<one sentence on what this journal collects, only when notebook_id is null>\", \
\"confidence\": 0.0, \
\"alternatives\": [\"<id or new-journal title of another journal this part could belong in>\"], \
\"question\": \"<only when confidence is below 0.6: one short question for the user, e.g. Does this belong in Q4 Budget or Backend Hiring?>\", \
\"title\": \"<short title for this part>\", \"summary\": \"<2-5 sentence notes>\", \
\"key_points\": [\"<decision, fact or action item>\"], \"start\": \"mm:ss\", \"end\": \"mm:ss\"}}]}}\n\
If nothing substantive was discussed, respond {{\"topics\": []}}.",
        title = meeting.title,
        date = format_local(&meeting.started_at),
        text = chunk.text,
    )
}

fn normalize_title(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn json_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "null")
        .map(str::to_string)
}

/// Reads a 0-1 confidence, tolerating percentages and words.
fn parse_confidence(value: Option<&serde_json::Value>) -> f64 {
    let raw = match value {
        Some(v) if v.is_number() => v.as_f64(),
        Some(v) => v.as_str().and_then(|s| match s.trim().to_lowercase().as_str() {
            "high" => Some(0.9),
            "medium" => Some(0.6),
            "low" => Some(0.3),
            other => other.trim_end_matches('%').parse::<f64>().ok(),
        }),
        None => None,
    };
    match raw {
        Some(n) if n > 1.0 => (n / 100.0).clamp(0.0, 1.0),
        Some(n) => n.clamp(0.0, 1.0),
        None => DEFAULT_CONFIDENCE,
    }
}

fn parse_topics(
    value: &serde_json::Value,
    notebooks: &[Notebook],
    proposed: &mut Vec<ProposedNotebook>,
    chunk: &TranscriptChunk,
) -> Vec<DraftTopic> {
    let Some(topics) = value.get("topics").and_then(|t| t.as_array()) else {
        return Vec::new();
    };

    let mut drafts = Vec::new();
    for topic in topics {
        let Some(summary) = json_str(topic, "summary") else { continue };
        let title = json_str(topic, "title").unwrap_or_else(|| summary.chars().take(60).collect());

        let new_title = json_str(topic, "new_notebook_title").unwrap_or_else(|| title.clone());
        let notebook = match json_str(topic, "notebook_id") {
            Some(id) => resolve_ref(&id, notebooks, proposed)
                .unwrap_or_else(|| resolve_new(&new_title, json_str(topic, "new_notebook_description"), notebooks, proposed)),
            None => resolve_new(&new_title, json_str(topic, "new_notebook_description"), notebooks, proposed),
        };

        let mut alternatives = Vec::new();
        for alternative in topic.get("alternatives").and_then(|a| a.as_array()).into_iter().flatten() {
            let Some(text) = alternative.as_str().map(str::trim).filter(|t| !t.is_empty()) else { continue };
            let reference = resolve_ref(text, notebooks, proposed)
                .unwrap_or_else(|| resolve_new(text, None, notebooks, proposed));
            if reference != notebook && !alternatives.contains(&reference) {
                alternatives.push(reference);
            }
        }

        let key_points = topic
            .get("key_points")
            .and_then(|k| k.as_array())
            .map(|points| {
                points
                    .iter()
                    .filter_map(|p| p.as_str().map(str::trim).filter(|p| !p.is_empty()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        // Keep the model's times only when they fall inside this chunk.
        let within = |t: f64| match (chunk.start, chunk.end) {
            (Some(s), Some(e)) => t >= s - 5.0 && t <= e + 5.0,
            _ => false,
        };
        let start = topic.get("start").and_then(parse_offset).filter(|t| within(*t)).or(chunk.start);
        let end = topic.get("end").and_then(parse_offset).filter(|t| within(*t)).or(chunk.end);
        let (start, end) = match (start, end) {
            (Some(s), Some(e)) if e < s => (Some(e), Some(s)),
            other => other,
        };

        drafts.push(DraftTopic {
            notebook,
            title,
            summary,
            key_points,
            start,
            end,
            confidence: parse_confidence(topic.get("confidence")),
            question: json_str(topic, "question"),
            alternatives,
        });
    }
    drafts
}

/// Matches an existing journal id, a "new-N" id from this run, or an existing/proposed title.
fn resolve_ref(
    text: &str,
    notebooks: &[Notebook],
    proposed: &[ProposedNotebook],
) -> Option<NotebookRef> {
    if notebooks.iter().any(|n| n.id == text) {
        return Some(NotebookRef::Existing(text.to_string()));
    }
    if let Some(index) = text.strip_prefix("new-").and_then(|n| n.parse::<usize>().ok()) {
        if index >= 1 && index <= proposed.len() {
            return Some(NotebookRef::New(index - 1));
        }
    }
    let key = normalize_title(text);
    if let Some(existing) = notebooks.iter().find(|n| normalize_title(&n.title) == key) {
        return Some(NotebookRef::Existing(existing.id.clone()));
    }
    proposed
        .iter()
        .position(|n| normalize_title(&n.title) == key)
        .map(NotebookRef::New)
}

/// A journal by title: reuses an existing or already proposed one, else proposes it.
fn resolve_new(
    title: &str,
    description: Option<String>,
    notebooks: &[Notebook],
    proposed: &mut Vec<ProposedNotebook>,
) -> NotebookRef {
    if let Some(reference) = resolve_ref(title, notebooks, proposed) {
        return reference;
    }
    proposed.push(ProposedNotebook { title: title.to_string(), description });
    NotebookRef::New(proposed.len() - 1)
}

/// One filed entry per journal per meeting: parts a long meeting returned to in
/// several transcript chunks are combined. Parts waiting for review stay separate
/// so each gets its own question.
fn merge_drafts(drafts: Vec<DraftTopic>) -> Vec<DraftTopic> {
    let mut merged: Vec<DraftTopic> = Vec::new();
    for draft in drafts {
        let target = if draft.needs_review() {
            None
        } else {
            merged.iter_mut().find(|m| !m.needs_review() && m.notebook == draft.notebook)
        };
        match target {
            Some(existing) => {
                existing.summary = format!("{}\n\n{}", existing.summary, draft.summary);
                for point in draft.key_points {
                    if !existing.key_points.contains(&point) {
                        existing.key_points.push(point);
                    }
                }
                existing.start = min_opt(existing.start, draft.start);
                existing.end = max_opt(existing.end, draft.end);
                existing.confidence = existing.confidence.min(draft.confidence).max(CONFIDENCE_THRESHOLD);
            }
            None => merged.push(draft),
        }
    }
    merged
}

fn min_opt(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

fn max_opt(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// Parses "mm:ss", "h:mm:ss", "[mm:ss]" or a plain number of seconds.
fn parse_offset(value: &serde_json::Value) -> Option<f64> {
    if let Some(n) = value.as_f64() {
        return Some(n);
    }
    let text = value.as_str()?.trim().trim_matches(|c| c == '[' || c == ']');
    let parts: Vec<f64> = text.split(':').map(|p| p.trim().parse::<f64>()).collect::<Result<_, _>>().ok()?;
    match parts.as_slice() {
        [s] => Some(*s),
        [m, s] => Some(m * 60.0 + s),
        [h, m, s] => Some(h * 3600.0 + m * 60.0 + s),
        _ => None,
    }
}

pub fn format_offset(seconds: f64) -> String {
    let total = seconds.max(0.0) as u64;
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

fn format_local(rfc3339: &str) -> String {
    parse_timestamp(rfc3339)
        .map(|dt| dt.with_timezone(&Local).format("%a %b %-d, %Y at %-I:%M %p").to_string())
        .unwrap_or_else(|| rfc3339.to_string())
}

fn format_local_date(rfc3339: &str) -> String {
    parse_timestamp(rfc3339)
        .map(|dt| dt.with_timezone(&Local).format("%b %-d, %Y").to_string())
        .unwrap_or_else(|| rfc3339.to_string())
}

// ---------------------------------------------------------------------------
// Notebook summaries
// ---------------------------------------------------------------------------

/// Reader-facing overview headings, in order.
const OVERVIEW_HEADINGS: &[&str] = &[
    "Where things stand",
    "What's been discussed",
    "Decisions made",
    "Still open",
    "How it unfolded",
];

const SUMMARY_SYSTEM_PROMPT: &str = "You write the overview page of one journal. The journal collects notes about one topic \
from many meetings, and the overview is read by the person who attended them, so write plainly and warmly, like a helpful colleague.\n\
Use exactly these five Markdown headings, in this order, and no other headings:\n\
## Where things stand\n\
## What's been discussed\n\
## Decisions made\n\
## Still open\n\
## How it unfolded\n\
Under the first heading write a short paragraph on the current state of the topic. \
Under the second, bullets for the main threads of conversation. \
Under the third, bullets for decisions, each ending with the date it was made in parentheses. \
Under the fourth, bullets for unanswered questions and to-dos, with who owns them and when they are due if known. \
Under the fifth, one bullet per meeting, oldest first, starting with the meeting date in bold. \
Never repeat these instructions in the overview. \
Use only the notes provided. When later notes contradict earlier ones, go with the later notes and say what changed. \
If the notes have nothing for a heading, write \"Nothing yet.\" under it.";

/// Older section names, mapped to the current headings.
const LEGACY_HEADINGS: &[(&str, &str)] = &[
    ("overview", "Where things stand"),
    ("key themes", "What's been discussed"),
    ("decisions", "Decisions made"),
    ("open questions", "Still open"),
    ("action items", "Still open"),
    ("timeline", "How it unfolded"),
];

/// Instruction fragments small models copy into their output.
const ECHOED_INSTRUCTIONS: &[&str] = &[
    "sentences on where things stand",
    "where things stand now.",
    "bullets, each ending with",
    "with owners and deadlines when known",
    "one bullet per meeting",
    "mon d, yyyy",
    "never repeat these instructions",
    "short paragraph on the current state",
    "bullets for the main threads",
];

/// Makes an overview reader-friendly: normalizes headings to the current names,
/// strips instructions the model echoed, and replaces "None recorded." Applied
/// when an overview is written and when stored overviews are shown.
pub fn clean_overview(markdown: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix('#') {
            let text = heading.trim_start_matches('#').trim();
            // "Overview - 3 to 5 sentences..." -> "Overview"
            let name = text
                .split(|c| c == '-' || c == '\u{2013}' || c == '\u{2014}' || c == ':' || c == '(')
                .next()
                .unwrap_or(text)
                .trim()
                .trim_end_matches('.');
            let lower = name.to_lowercase();
            let current = OVERVIEW_HEADINGS.iter().find(|h| h.to_lowercase() == lower).copied();
            let legacy = LEGACY_HEADINGS.iter().find(|(old, _)| lower.starts_with(old)).map(|(_, new)| *new);
            match current.or(legacy) {
                Some(friendly) => {
                    // Two legacy names can map to the same heading; keep the first.
                    let heading_line = format!("## {friendly}");
                    if !lines.contains(&heading_line) {
                        lines.push(heading_line);
                    }
                }
                None => lines.push(line.to_string()),
            }
            continue;
        }
        let lower = trimmed.to_lowercase();
        if ECHOED_INSTRUCTIONS.iter().any(|fragment| lower.contains(fragment)) {
            continue;
        }
        if lower.trim_matches(|c: char| c == '*' || c == '_' || c == '-' || c.is_whitespace()) == "none recorded." {
            lines.push("Nothing yet.".to_string());
            continue;
        }
        lines.push(line.to_string());
    }
    lines.join("\n").trim().to_string()
}

pub async fn summarize_notebook<R: Runtime>(
    app: &AppHandle<R>,
    pool: &SqlitePool,
    notebook_id: &str,
) -> Result<(String, String), String> {
    let notebook = JournalRepository::get_notebook(pool, notebook_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Notebook not found")?;
    let mut entries = JournalRepository::list_entries(pool, Some(notebook_id))
        .await
        .map_err(|e| e.to_string())?;
    if entries.is_empty() {
        return Err("This notebook has no notes to summarize yet".into());
    }
    entries.reverse(); // oldest meeting first

    let llm = JournalLlm::from_settings(app, pool).await?;
    let budget = llm.context_chars().saturating_sub(2_500).max(4_000);

    let blocks: Vec<String> = entries.iter().map(entry_block).collect();
    let groups = group_by_budget(&blocks, budget);

    let header = format!(
        "Notebook: \"{}\"{}\n\n",
        notebook.title,
        notebook.description.as_deref().map(|d| format!(" - {d}")).unwrap_or_default()
    );

    let notes = if groups.len() == 1 {
        groups.into_iter().next().unwrap_or_default()
    } else {
        // Too many notes for one prompt: condense each slice of the timeline first.
        let mut condensed = Vec::new();
        for (i, group) in groups.iter().enumerate() {
            let prompt = format!(
                "{header}Condense these notes (part {} of {}) into dated bullet points. Keep every decision, number, owner and deadline, and keep the dates.\n\n{group}",
                i + 1,
                groups.len()
            );
            condensed.push(
                llm.complete("You condense meeting notes without losing facts or dates.", &prompt)
                    .await?,
            );
        }
        condensed.join("\n\n")
    };

    let prompt = format!("{header}Notes, oldest first:\n\n{notes}\n\nWrite the journal overview.");
    let markdown = clean_overview(&llm.complete(SUMMARY_SYSTEM_PROMPT, &prompt).await?);
    let updated_at = JournalRepository::set_summary(pool, notebook_id, &markdown)
        .await
        .map_err(|e| e.to_string())?;

    // Decides whether the journal offers "Create requirements". A failed check isn't worth failing the overview over.
    match classify_software(&llm, &notebook, &markdown).await {
        Ok(is_software) => {
            let _ = JournalRepository::set_is_software(pool, notebook_id, is_software).await;
        }
        Err(e) => warn!("Journal: could not classify {notebook_id}: {e}"),
    }
    Ok((markdown, updated_at))
}

const SOFTWARE_SYSTEM_PROMPT: &str = "You decide whether a journal of meeting notes is about building, changing or fixing \
software: an app, website, internal tool, integration, API or other digital product, including its features, bugs, \
screens, data or releases. Answer with one word: yes or no.";

async fn classify_software(llm: &JournalLlm, notebook: &Notebook, overview: &str) -> Result<bool, String> {
    let overview: String = overview.chars().take(3_000).collect();
    let prompt = format!(
        "Journal: \"{}\"{}\n\nOverview:\n{overview}\n\nIs this journal about building, changing or fixing software? Answer yes or no.",
        notebook.title,
        notebook.description.as_deref().map(|d| format!(" - {d}")).unwrap_or_default(),
    );
    let reply = llm.complete(SOFTWARE_SYSTEM_PROMPT, &prompt).await?;
    Ok(parse_yes_no(&reply))
}

/// Classifies a journal that has an overview but predates the software flag.
pub fn spawn_classify<R: Runtime>(app: AppHandle<R>, notebook_id: String) {
    if !mark_active(&format!("classify:{notebook_id}")) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let key = format!("classify:{notebook_id}");
        let result = async {
            let pool = pool_from_app(&app)?;
            let _guard = ORGANIZE_LOCK.lock().await;
            let notebook = JournalRepository::get_notebook(&pool, &notebook_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("Journal not found")?;
            let Some(overview) = notebook.summary_markdown.clone() else { return Ok(()) };
            let llm = JournalLlm::from_settings(&app, &pool).await?;
            let is_software = classify_software(&llm, &notebook, &overview).await?;
            JournalRepository::set_is_software(&pool, &notebook_id, is_software)
                .await
                .map_err(|e| e.to_string())?;
            emit_updated(&app, None, "notebooks-changed", None);
            Ok::<(), String>(())
        }
        .await;
        if let Err(e) = result {
            warn!("Journal: could not classify {notebook_id}: {e}");
        }
        unmark_active(&key);
    });
}

fn parse_yes_no(reply: &str) -> bool {
    reply
        .trim()
        .trim_start_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
        .starts_with("yes")
}

/// The journal as a brief for the requirements agent: every filed note, oldest
/// first, each with the transcript it came from. Returns (date range, brief).
pub async fn requirements_brief(pool: &SqlitePool, notebook_id: &str) -> Result<(String, String), String> {
    let mut entries = JournalRepository::list_entries(pool, Some(notebook_id))
        .await
        .map_err(|e| e.to_string())?;
    if entries.is_empty() {
        return Err("This journal has no notes yet".into());
    }
    entries.reverse(); // oldest meeting first

    let mut transcripts: HashMap<String, Vec<TranscriptLine>> = HashMap::new();
    let mut brief = String::new();
    for entry in &entries {
        brief.push_str(&entry_block(entry));
        if !transcripts.contains_key(&entry.meeting_id) {
            let lines = JournalRepository::get_transcript_lines(pool, &entry.meeting_id)
                .await
                .map_err(|e| e.to_string())?;
            transcripts.insert(entry.meeting_id.clone(), lines);
        }
        let excerpt: Vec<String> = transcripts[&entry.meeting_id]
            .iter()
            .filter(|line| match (entry.start_time, entry.end_time, line.start) {
                (Some(s), Some(e), Some(t)) => t >= s - ENTRY_PADDING_SECS && t <= e + ENTRY_PADDING_SECS,
                _ => true,
            })
            .map(|line| match line.start {
                Some(t) => format!("> [{}] {}", format_offset(t), line.text),
                None => format!("> {}", line.text),
            })
            .collect();
        if !excerpt.is_empty() {
            brief.push_str("\nTranscript excerpt:\n");
            brief.push_str(&excerpt.join("\n"));
            brief.push('\n');
        }
        brief.push('\n');
    }

    let meetings: HashSet<&str> = entries.iter().map(|e| e.meeting_id.as_str()).collect();
    let first = format_local_date(&entries[0].meeting_started_at);
    let last = format_local_date(&entries[entries.len() - 1].meeting_started_at);
    let range = if first == last { first } else { format!("{first} to {last}") };
    let count = meetings.len();
    Ok((format!("{range} ({count} {})", if count == 1 { "meeting" } else { "meetings" }), brief))
}

fn entry_block(entry: &NotebookEntry) -> String {
    let mut block = format!(
        "### {} - meeting \"{}\"\n**{}**\n{}\n",
        format_local_date(&entry.meeting_started_at),
        entry.meeting_title,
        entry.title,
        entry.summary
    );
    for point in &entry.key_points {
        block.push_str(&format!("- {point}\n"));
    }
    block
}

fn group_by_budget(blocks: &[String], budget: usize) -> Vec<String> {
    let mut groups = vec![String::new()];
    for block in blocks {
        let current = groups.last_mut().expect("groups is never empty");
        if !current.is_empty() && current.len() + block.len() > budget {
            groups.push(block.clone());
        } else {
            current.push_str(block);
            current.push('\n');
        }
    }
    groups
}

// ---------------------------------------------------------------------------
// Asking a notebook questions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct AskTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskSource {
    pub id: usize,
    /// "note" for a notebook entry summary, "transcript" for recorded speech.
    pub kind: String,
    pub meeting_id: String,
    pub meeting_title: String,
    pub meeting_date: String,
    pub meeting_started_at: String,
    pub notebook_id: Option<String>,
    pub entry_title: Option<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskAnswer {
    pub answer: String,
    /// Only the sources the answer cites, in id order.
    pub sources: Vec<AskSource>,
}

const ASK_SYSTEM_PROMPT: &str = "You answer questions about the user's own meetings using only the numbered sources from their journal. \
Cite sources inline with their numbers in square brackets, like [2] or [1][4], right after the claim they support. \
Say when things were discussed (the date) when it helps, and if the answer changed over time, give the latest position and note the earlier one. \
If the sources don't answer the question, say you couldn't find it in these meetings. Never guess or use outside knowledge. \
Be concise and use Markdown bullets for lists.";

const PASSAGE_CHARS: usize = 900;
/// Transcript context taken around an entry's time range, in seconds.
const ENTRY_PADDING_SECS: f64 = 20.0;

pub async fn ask<R: Runtime>(
    app: &AppHandle<R>,
    pool: &SqlitePool,
    notebook_id: Option<&str>,
    question: &str,
    history: &[AskTurn],
) -> Result<AskAnswer, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("Ask a question first".into());
    }
    let entries = JournalRepository::list_entries(pool, notebook_id)
        .await
        .map_err(|e| e.to_string())?;
    if entries.is_empty() {
        return Err("There are no notes here to answer from yet".into());
    }

    let llm = JournalLlm::from_settings(app, pool).await?;
    let candidates = build_candidates(pool, &entries, notebook_id).await?;

    // Follow-ups like "and who owns that?" lean on the previous question's terms.
    let previous_question = history.iter().rev().find(|t| t.role == "user").map(|t| t.content.as_str());
    let query = format!("{question} {}", previous_question.unwrap_or(""));
    let budget = llm.context_chars().saturating_sub(3_000).max(3_000);
    let selected = select_passages(candidates, &query, budget);

    let mut sources_text = String::new();
    for source in &selected {
        let when = match source.start_time {
            Some(t) => format!(", {} into the recording", format_offset(t)),
            None => String::new(),
        };
        let label = match (&source.kind[..], &source.entry_title) {
            ("note", Some(title)) => format!("journal note \"{title}\""),
            _ => "transcript".to_string(),
        };
        sources_text.push_str(&format!(
            "[{}] {} from meeting \"{}\" on {}{}:\n{}\n\n",
            source.id,
            label,
            source.meeting_title,
            format_local(&source.meeting_started_at),
            when,
            source.excerpt
        ));
    }

    let mut conversation = String::new();
    for turn in history.iter().rev().take(6).collect::<Vec<_>>().into_iter().rev() {
        let content: String = turn.content.chars().take(600).collect();
        let speaker = if turn.role == "user" { "User" } else { "Assistant" };
        conversation.push_str(&format!("{speaker}: {content}\n"));
    }
    let conversation = if conversation.is_empty() {
        String::new()
    } else {
        format!("Conversation so far:\n{conversation}\n")
    };

    let prompt = format!(
        "Today is {today}.\n\nSources:\n{sources_text}{conversation}Question: {question}",
        today = Local::now().format("%a %b %-d, %Y"),
    );
    let answer = llm.complete(ASK_SYSTEM_PROMPT, &prompt).await?;

    let cited = cited_ids(&answer);
    let sources = selected.into_iter().filter(|s| cited.contains(&s.id)).collect();
    Ok(AskAnswer { answer, sources })
}

/// Every passage the answer could draw on: each entry's notes, plus the
/// transcript around the time range each entry came from.
async fn build_candidates(
    pool: &SqlitePool,
    entries: &[NotebookEntry],
    notebook_id: Option<&str>,
) -> Result<Vec<AskSource>, String> {
    let mut candidates = Vec::new();
    for entry in entries {
        let mut excerpt = entry.summary.clone();
        for point in &entry.key_points {
            excerpt.push_str(&format!("\n- {point}"));
        }
        candidates.push(AskSource {
            id: 0,
            kind: "note".into(),
            meeting_id: entry.meeting_id.clone(),
            meeting_title: entry.meeting_title.clone(),
            meeting_date: entry.meeting_date.clone(),
            meeting_started_at: entry.meeting_started_at.clone(),
            notebook_id: entry.notebook_id.clone(),
            entry_title: Some(entry.title.clone()),
            start_time: entry.start_time,
            end_time: entry.end_time,
            excerpt,
        });
    }

    let mut by_meeting: HashMap<&str, Vec<&NotebookEntry>> = HashMap::new();
    for entry in entries {
        by_meeting.entry(entry.meeting_id.as_str()).or_default().push(entry);
    }

    for (meeting_id, meeting_entries) in by_meeting {
        let lines = JournalRepository::get_transcript_lines(pool, meeting_id)
            .await
            .map_err(|e| e.to_string())?;
        // Across the whole journal, every line of these meetings is relevant;
        // inside a notebook, only the stretches its entries came from.
        let mut wanted: BTreeSet<usize> = BTreeSet::new();
        for (index, line) in lines.iter().enumerate() {
            let include = notebook_id.is_none()
                || meeting_entries.iter().any(|entry| match (entry.start_time, entry.end_time, line.start) {
                    (Some(s), Some(e), Some(t)) => t >= s - ENTRY_PADDING_SECS && t <= e + ENTRY_PADDING_SECS,
                    _ => true,
                });
            if include {
                wanted.insert(index);
            }
        }

        let first = meeting_entries[0];
        let mut passage: Option<AskSource> = None;
        let mut previous: Option<usize> = None;
        for index in wanted {
            let line = &lines[index];
            let contiguous = previous.map_or(false, |p| p + 1 == index);
            let full = passage.as_ref().map_or(false, |p| p.excerpt.len() + line.text.len() > PASSAGE_CHARS);
            if !contiguous || full {
                candidates.extend(passage.take());
            }
            let current = passage.get_or_insert_with(|| AskSource {
                id: 0,
                kind: "transcript".into(),
                meeting_id: first.meeting_id.clone(),
                meeting_title: first.meeting_title.clone(),
                meeting_date: first.meeting_date.clone(),
                meeting_started_at: first.meeting_started_at.clone(),
                notebook_id: notebook_id.map(str::to_string),
                entry_title: None,
                start_time: line.start,
                end_time: line.end,
                excerpt: String::new(),
            });
            if !current.excerpt.is_empty() {
                current.excerpt.push(' ');
            }
            current.excerpt.push_str(&line.text);
            current.end_time = line.end.or(line.start).or(current.end_time);
            previous = Some(index);
        }
        candidates.extend(passage);
    }
    Ok(candidates)
}

static STOPWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    "the and for are but not you all any can had her was one our out has his how its may new now old see two who did get got him let put say she too use what when where which while with would could should about after again also been before being both does each from have into just like more most much only other over same some such than that them then there these they this those very what whom why will your yours yeah okay know think going want really thing things said tell".split_whitespace().collect()
});

fn terms(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3 && !STOPWORDS.contains(w))
        .map(str::to_string)
        .collect()
}

/// Keeps everything when it fits; otherwise the passages that best match the
/// question (keyword overlap weighted by rarity), then numbers them oldest first.
fn select_passages(candidates: Vec<AskSource>, query: &str, budget: usize) -> Vec<AskSource> {
    let total: usize = candidates.iter().map(|c| c.excerpt.len() + 120).sum();
    let mut chosen: Vec<AskSource> = if total <= budget {
        candidates
    } else {
        let query_terms: HashSet<String> = terms(query).into_iter().collect();
        let passage_terms: Vec<Vec<String>> = candidates.iter().map(|c| terms(&c.excerpt)).collect();
        let n = candidates.len() as f64;
        let idf: HashMap<&String, f64> = query_terms
            .iter()
            .map(|term| {
                let df = passage_terms.iter().filter(|p| p.contains(term)).count() as f64;
                (term, (1.0 + n / (df + 1.0)).ln())
            })
            .collect();

        let mut scored: Vec<(f64, AskSource)> = candidates
            .into_iter()
            .zip(passage_terms)
            .map(|(candidate, words)| {
                let mut score: f64 = query_terms
                    .iter()
                    .map(|term| (words.iter().filter(|w| *w == term).count().min(3) as f64) * idf[term])
                    .sum();
                // Notes are dense; prefer them slightly, and recent meetings on ties.
                if candidate.kind == "note" {
                    score += 0.5;
                }
                (score, candidate)
            })
            .collect();
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.1.meeting_date.cmp(&a.1.meeting_date))
        });

        let mut used = 0;
        let mut picked = Vec::new();
        for (_, candidate) in scored {
            let cost = candidate.excerpt.len() + 120;
            if used + cost > budget {
                continue;
            }
            used += cost;
            picked.push(candidate);
        }
        picked
    };

    chosen.sort_by(|a, b| {
        a.meeting_started_at
            .cmp(&b.meeting_started_at)
            .then_with(|| a.start_time.unwrap_or(0.0).partial_cmp(&b.start_time.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| b.kind.cmp(&a.kind)) // transcript after the note it supports
    });
    for (index, source) in chosen.iter_mut().enumerate() {
        source.id = index + 1;
    }
    chosen
}

static CITATION: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[(\d+(?:\s*,\s*\d+)*)\]").unwrap());

fn cited_ids(answer: &str) -> HashSet<usize> {
    CITATION
        .captures_iter(answer)
        .flat_map(|caps| {
            caps[1]
                .split(',')
                .filter_map(|n| n.trim().parse::<usize>().ok())
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_echoed_overview_instructions() {
        let raw = "## Overview - 3 to 5 sentences on where things stand now.\nBudget is cut by 10%.\n\n## Key themes - bullets.\n- Vendors\n## Open questions & action items\nNone recorded.\n## Timeline - one bullet per meeting, oldest first: **Mon D, YYYY** - what happened.\n- **Sep 30, 2026** - Agreed cuts.";
        let cleaned = clean_overview(raw);
        assert_eq!(
            cleaned,
            "## Where things stand\nBudget is cut by 10%.\n\n## What's been discussed\n- Vendors\n## Still open\nNothing yet.\n## How it unfolded\n- **Sep 30, 2026** - Agreed cuts."
        );
    }

    #[test]
    fn reads_yes_no_answers() {
        assert!(parse_yes_no("Yes."));
        assert!(parse_yes_no("**yes** - it covers the mobile app"));
        assert!(!parse_yes_no("No, this is about hiring."));
        assert!(!parse_yes_no(""));
    }

    #[test]
    fn parses_offsets() {
        assert_eq!(parse_offset(&serde_json::json!("01:30")), Some(90.0));
        assert_eq!(parse_offset(&serde_json::json!("[1:02:03]")), Some(3723.0));
        assert_eq!(parse_offset(&serde_json::json!(42)), Some(42.0));
        assert_eq!(parse_offset(&serde_json::json!("soon")), None);
    }

    #[test]
    fn finds_citations() {
        let ids = cited_ids("Budget was cut [2]. Owner is Sam [1, 4][3].");
        assert_eq!(ids, HashSet::from([1, 2, 3, 4]));
    }

    #[test]
    fn reuses_notebooks_by_title() {
        let chunk = TranscriptChunk { text: String::new(), start: Some(0.0), end: Some(100.0) };
        let notebooks = vec![Notebook {
            id: "notebook-1".into(),
            title: "Q4 Budget".into(),
            description: None,
            color: "indigo".into(),
            auto_created: true,
            summary_markdown: None,
            summary_updated_at: None,
            created_at: String::new(),
            updated_at: String::new(),
            is_software: None,
        }];
        let mut proposed = Vec::new();
        let value = serde_json::json!({"topics": [
            {"notebook_id": null, "new_notebook_title": "q4 budget", "title": "Cuts", "summary": "Cut 10%.", "start": "00:10", "end": "05:00"},
            {"notebook_id": null, "new_notebook_title": "Hiring", "title": "Roles", "summary": "Two roles.", "start": "99:00"},
            {"notebook_id": "new-1", "title": "More roles", "summary": "One more."}
        ]});
        let drafts = parse_topics(&value, &notebooks, &mut proposed, &chunk);
        assert!(drafts[0].notebook == NotebookRef::Existing("notebook-1".into()));
        assert_eq!(drafts[0].start, Some(10.0));
        assert!(drafts[1].notebook == NotebookRef::New(0));
        assert_eq!(drafts[1].start, Some(0.0)); // out-of-range time falls back to the chunk
        assert!(drafts[2].notebook == NotebookRef::New(0));
        assert_eq!(merge_drafts(drafts).len(), 2);
    }

    #[test]
    fn low_confidence_parts_wait_for_review_with_suggestions() {
        let chunk = TranscriptChunk { text: String::new(), start: Some(0.0), end: Some(100.0) };
        let notebooks = vec![Notebook {
            id: "notebook-1".into(),
            title: "Q4 Budget".into(),
            description: None,
            color: "indigo".into(),
            auto_created: true,
            summary_markdown: None,
            summary_updated_at: None,
            created_at: String::new(),
            updated_at: String::new(),
            is_software: None,
        }];
        let mut proposed = Vec::new();
        let value = serde_json::json!({"topics": [
            {"notebook_id": "notebook-1", "confidence": 0.4, "alternatives": ["Vendor Contracts", "notebook-1"],
             "question": "Budget or vendors?", "title": "Vendor costs", "summary": "Vendor A is 20% more."},
            {"notebook_id": "notebook-1", "confidence": "95%", "title": "Cuts", "summary": "Cut 10%."},
            {"notebook_id": "notebook-1", "confidence": 0.3, "title": "Other", "summary": "Unclear."}
        ]});
        let drafts = parse_topics(&value, &notebooks, &mut proposed, &chunk);
        assert!(drafts[0].needs_review());
        assert!(drafts[0].alternatives == vec![NotebookRef::New(0)]); // the duplicate primary is dropped
        assert_eq!(proposed[0].title, "Vendor Contracts");
        assert!((drafts[1].confidence - 0.95).abs() < 1e-9);
        // Review parts never merge, even into the same journal.
        assert_eq!(merge_drafts(drafts).len(), 3);
    }
}
