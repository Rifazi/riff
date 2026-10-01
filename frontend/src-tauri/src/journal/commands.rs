//! Tauri commands for the Journal view.

use super::repository::{
    JournalRepository, MeetingJournalStatus, MeetingJournalTag, Notebook, NotebookEntry, NotebookOverview,
};
use super::service::{self, AskAnswer, AskTurn};
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, Runtime};

#[derive(Serialize)]
pub struct NotebookDetail {
    pub notebook: Notebook,
    pub entries: Vec<NotebookEntry>,
}

#[derive(Serialize)]
pub struct NotebookSummary {
    pub summary_markdown: String,
    pub summary_updated_at: String,
}

#[tauri::command]
pub async fn journal_list_notebooks(state: tauri::State<'_, AppState>) -> Result<Vec<NotebookOverview>, String> {
    let mut overviews = JournalRepository::list_overviews(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?;
    for overview in &mut overviews {
        clean_stored_overview(&mut overview.notebook);
    }
    Ok(overviews)
}

/// Overviews written before the reader-friendly headings get them on the way out.
fn clean_stored_overview(notebook: &mut Notebook) {
    if let Some(markdown) = notebook.summary_markdown.as_mut() {
        *markdown = service::clean_overview(markdown);
    }
}

#[tauri::command]
pub async fn journal_get_notebook<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    notebook_id: String,
) -> Result<NotebookDetail, String> {
    let pool = state.db_manager.pool();
    let mut notebook = JournalRepository::get_notebook(pool, &notebook_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Journal not found")?;
    clean_stored_overview(&mut notebook);
    if notebook.is_software.is_none() && notebook.summary_markdown.is_some() {
        service::spawn_classify(app, notebook_id.clone());
    }
    let entries = JournalRepository::list_entries(pool, Some(&notebook_id))
        .await
        .map_err(|e| e.to_string())?;
    Ok(NotebookDetail { notebook, entries })
}

#[tauri::command]
pub async fn journal_create_notebook<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    title: String,
    description: Option<String>,
) -> Result<Notebook, String> {
    if title.trim().is_empty() {
        return Err("A notebook needs a title".into());
    }
    let notebook = JournalRepository::create_notebook(state.db_manager.pool(), &title, description.as_deref(), false)
        .await
        .map_err(|e| e.to_string())?;
    service::emit_updated(&app, None, "notebooks-changed", None);
    Ok(notebook)
}

#[tauri::command]
pub async fn journal_update_notebook<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    notebook_id: String,
    title: Option<String>,
    description: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    let updated = JournalRepository::update_notebook(
        state.db_manager.pool(),
        &notebook_id,
        title.as_deref(),
        description.as_deref(),
        color.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    if !updated {
        return Err("Notebook not found".into());
    }
    service::emit_updated(&app, None, "notebooks-changed", None);
    Ok(())
}

#[tauri::command]
pub async fn journal_delete_notebook<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    notebook_id: String,
) -> Result<(), String> {
    JournalRepository::delete_notebook(state.db_manager.pool(), &notebook_id)
        .await
        .map_err(|e| e.to_string())?;
    service::emit_updated(&app, None, "notebooks-changed", None);
    Ok(())
}

#[tauri::command]
pub async fn journal_merge_notebooks<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    source_id: String,
    target_id: String,
) -> Result<(), String> {
    if source_id == target_id {
        return Err("Pick a different notebook to merge into".into());
    }
    JournalRepository::merge_notebooks(state.db_manager.pool(), &source_id, &target_id)
        .await
        .map_err(|e| e.to_string())?;
    service::emit_updated(&app, None, "notebooks-changed", None);
    Ok(())
}

/// Files a part into a journal: moving a filed note, or answering the organizer's
/// question about a part it wasn't sure of. Pass `new_title` instead of
/// `notebook_id` to file it into a new journal.
#[tauri::command]
pub async fn journal_move_entry<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    entry_id: String,
    notebook_id: Option<String>,
    new_title: Option<String>,
    new_description: Option<String>,
) -> Result<String, String> {
    let pool = state.db_manager.pool();
    let meeting_id = JournalRepository::entry_meeting_id(pool, &entry_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Note not found")?;
    let notebook_id = match (notebook_id, new_title.as_deref().map(str::trim).filter(|t| !t.is_empty())) {
        (Some(id), _) => id,
        (None, Some(title)) => {
            JournalRepository::create_notebook(pool, title, new_description.as_deref(), false)
                .await
                .map_err(|e| e.to_string())?
                .id
        }
        (None, None) => return Err("Pick a journal".into()),
    };
    JournalRepository::move_entry(pool, &entry_id, &notebook_id)
        .await
        .map_err(|e| e.to_string())?;
    JournalRepository::prune_empty_auto_notebooks(pool)
        .await
        .map_err(|e| e.to_string())?;
    service::refresh_meeting_status(&app, pool, &meeting_id).await?;
    service::emit_updated(&app, None, "notebooks-changed", None);
    service::spawn_compile_journals(app, vec![notebook_id.clone()]);
    Ok(notebook_id)
}

#[tauri::command]
pub async fn journal_delete_entry<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    entry_id: String,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let meeting_id = JournalRepository::entry_meeting_id(pool, &entry_id)
        .await
        .map_err(|e| e.to_string())?;
    JournalRepository::delete_entry(pool, &entry_id)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(meeting_id) = meeting_id {
        service::refresh_meeting_status(&app, pool, &meeting_id).await?;
    }
    service::emit_updated(&app, None, "notebooks-changed", None);
    Ok(())
}

/// Parts of meetings the organizer wasn't sure about, waiting for the user to pick a journal.
#[tauri::command]
pub async fn journal_list_review(state: tauri::State<'_, AppState>) -> Result<Vec<NotebookEntry>, String> {
    JournalRepository::list_review_entries(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

/// How one meeting was split up and filed, including parts waiting for review.
#[tauri::command]
pub async fn journal_get_meeting_entries(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<NotebookEntry>, String> {
    JournalRepository::list_meeting_entries(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

/// Files (or re-files) one meeting in the background; progress arrives as `journal-updated` events.
#[tauri::command]
pub async fn journal_organize_meeting<R: Runtime>(app: AppHandle<R>, meeting_id: String) -> Result<(), String> {
    service::spawn_organize(app, meeting_id);
    Ok(())
}

/// Files every meeting that hasn't been filed yet (or failed last time), one after another.
/// Returns how many were queued.
#[tauri::command]
pub async fn journal_organize_pending<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<usize, String> {
    let statuses = service::meeting_statuses(state.db_manager.pool()).await?;
    let pending: Vec<String> = statuses
        .into_iter()
        .filter(|s| s.status == "unfiled" || s.status == "failed")
        .map(|s| s.meeting_id)
        .collect();
    let count = pending.len();
    for meeting_id in pending {
        service::spawn_organize(app.clone(), meeting_id);
    }
    Ok(count)
}

#[tauri::command]
pub async fn journal_get_meeting_statuses(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MeetingJournalStatus>, String> {
    service::meeting_statuses(state.db_manager.pool()).await
}

#[tauri::command]
pub async fn journal_summarize_notebook<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    notebook_id: String,
) -> Result<NotebookSummary, String> {
    let pool = state.db_manager.pool().clone();
    let (summary_markdown, summary_updated_at) = service::summarize_notebook(&app, &pool, &notebook_id).await?;
    service::emit_updated(&app, None, "notebooks-changed", None);
    Ok(NotebookSummary { summary_markdown, summary_updated_at })
}

/// Answers a question from a notebook's meetings, or from the whole journal when `notebook_id` is omitted.
#[tauri::command]
pub async fn journal_ask<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    notebook_id: Option<String>,
    question: String,
    history: Option<Vec<AskTurn>>,
) -> Result<AskAnswer, String> {
    let pool = state.db_manager.pool().clone();
    service::ask(&app, &pool, notebook_id.as_deref(), &question, &history.unwrap_or_default()).await
}

/// Which journals each meeting was filed into, for tagging meeting lists.
#[tauri::command]
pub async fn journal_meeting_tags(state: tauri::State<'_, AppState>) -> Result<Vec<MeetingJournalTag>, String> {
    JournalRepository::meeting_journal_tags(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct RequirementsBrief {
    /// e.g. "Sep 2, 2026 to Sep 30, 2026 (4 meetings)"
    pub covers: String,
    pub notes_markdown: String,
}

/// The journal's notes and transcript excerpts, for starting a Dev Session from it.
#[tauri::command]
pub async fn journal_requirements_brief(
    state: tauri::State<'_, AppState>,
    notebook_id: String,
) -> Result<RequirementsBrief, String> {
    let (covers, notes_markdown) = service::requirements_brief(state.db_manager.pool(), &notebook_id).await?;
    Ok(RequirementsBrief { covers, notes_markdown })
}
