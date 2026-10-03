//! Tauri commands for search (`frontend/src/lib/search`).

use super::{service, SearchStatus, KIND_JOURNAL, KIND_JOURNAL_NOTE, KIND_SUMMARY, KIND_TRANSCRIPT, SCOPE};
use riff_search::{Hit, Query};
use tauri::{AppHandle, Runtime};

/// Searches meetings and journals. `kinds` narrows it (transcript, summary,
/// journal, journal_note); `grouped` returns one result per meeting/journal.
#[tauri::command]
pub async fn search<R: Runtime>(
    app: AppHandle<R>,
    query: String,
    kinds: Option<Vec<String>>,
    limit: Option<usize>,
    grouped: Option<bool>,
) -> Result<Vec<Hit>, String> {
    let service = service(&app).await?;
    // Catches anything saved since the worker last looked.
    if let Err(e) = service.sync(&app, true).await {
        log::warn!("search: sync before search failed: {e}");
    }
    let known = [KIND_TRANSCRIPT, KIND_SUMMARY, KIND_JOURNAL, KIND_JOURNAL_NOTE];
    let kinds: Vec<String> = kinds.unwrap_or_default().into_iter().filter(|k| known.contains(&k.as_str())).collect();
    let query = Query {
        text: query,
        scopes: vec![SCOPE.to_string()],
        kinds,
        limit: limit.unwrap_or(30).min(200),
        grouped: grouped.unwrap_or(true),
    };
    service.index.search(&query).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_status<R: Runtime>(app: AppHandle<R>) -> Result<SearchStatus, String> {
    service(&app).await?.status().await
}

/// Downloads (if needed) and loads the embedding model for search by meaning.
#[tauri::command]
pub async fn search_download_model<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let service = service(&app).await?;
    service.download_model(&app).await?;
    service.load_model(&app).await;
    Ok(())
}

/// Deletes the embedding model; search falls back to keywords.
#[tauri::command]
pub async fn search_remove_model<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    service(&app).await?.remove_model(&app).await
}

/// Drops and rebuilds the whole index from the meetings database.
#[tauri::command]
pub async fn search_rebuild_index<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let service = service(&app).await?;
    service.rebuild(&app).await?;
    service.wake();
    Ok(())
}
