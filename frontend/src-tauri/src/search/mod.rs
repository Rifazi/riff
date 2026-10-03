//! Search across meetings and journals, on top of the shared `riff-search`
//! engine (FTS5 keyword search + local embeddings, fused by rank). The Dev
//! Sessions agents search their docs with the same engine (`riff --search-stdio`).
//!
//! - `sources` - reconciles the index from the meetings database by fingerprint
//! - `model` - downloads the embedding model
//! - `commands` - Tauri commands used by the meetings list, the journal shelf and Settings
//!
//! The index (`search.sqlite` in the app data dir) is derived data: deleting it
//! just rebuilds it. A background worker keeps it in sync (every minute, after
//! each search, and on `wake`) and embeds new chunks, pausing while recording.

pub mod commands;
mod model;
mod sources;

use crate::state::AppState;
use riff_search::{Embedder, Index, DEFAULT_MODEL};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Everything the app indexes lives in one scope; queries filter by kind.
pub const SCOPE: &str = "riff";
pub const KIND_TRANSCRIPT: &str = "transcript";
pub const KIND_SUMMARY: &str = "summary";
pub const KIND_JOURNAL: &str = "journal";
pub const KIND_JOURNAL_NOTE: &str = "journal_note";

const SYNC_INTERVAL: Duration = Duration::from_secs(60);
/// A search re-checks the database at most this often.
const SEARCH_SYNC_THROTTLE: Duration = Duration::from_secs(2);
/// Chunks embedded between checks for new work or a recording starting.
const EMBED_STEP: usize = 64;
/// Set when the person removed the model, so it isn't downloaded again on its own.
const SETTING_MODEL_DECLINED: &str = "model_declined";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub size_bytes: u64,
    pub installed: bool,
    pub loaded: bool,
    pub downloading: bool,
    pub downloaded_bytes: u64,
    pub declined: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchStatus {
    pub documents: i64,
    pub chunks: i64,
    pub embedded: i64,
    pub model: ModelStatus,
    pub index_path: String,
}

pub struct SearchService {
    pub index: Index,
    index_path: PathBuf,
    model_dir: PathBuf,
    model: Mutex<ModelStatus>,
    sync_lock: tokio::sync::Mutex<()>,
    last_sync: Mutex<Option<Instant>>,
    wake: tokio::sync::Notify,
}

/// Managed state; the service opens on first use.
#[derive(Default)]
pub struct SearchState(tokio::sync::OnceCell<Arc<SearchService>>);

pub async fn service<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<SearchService>, String> {
    let state = app.state::<SearchState>();
    state
        .0
        .get_or_try_init(|| async {
            let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let index_path = data_dir.join("search.sqlite");
            let index = Index::open(&index_path).await.map_err(|e| format!("opening search index: {e}"))?;
            let model_dir = data_dir.join("models").join("embeddings").join(DEFAULT_MODEL.dir);
            let declined = index.setting(SETTING_MODEL_DECLINED).await.ok().flatten().is_some();
            let model = ModelStatus {
                id: DEFAULT_MODEL.id.to_string(),
                size_bytes: DEFAULT_MODEL.download_size(),
                installed: DEFAULT_MODEL.is_installed(&model_dir),
                declined,
                ..Default::default()
            };
            Ok(Arc::new(SearchService {
                index,
                index_path,
                model_dir,
                model: Mutex::new(model),
                sync_lock: tokio::sync::Mutex::new(()),
                last_sync: Mutex::new(None),
                wake: tokio::sync::Notify::new(),
            }))
        })
        .await
        .cloned()
}

/// Where the agent server's search process finds the embedding model.
pub fn embedding_models_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("models").join("embeddings"))
}

/// Starts the background worker (app setup).
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let service = match service(&app).await {
            Ok(service) => service,
            Err(e) => return log::error!("search: {e}"),
        };
        // Keyword search works while the model downloads.
        let (for_model, app_for_model) = (service.clone(), app.clone());
        tauri::async_runtime::spawn(async move { for_model.prepare_model(&app_for_model).await });
        service.run(&app).await;
    });
}

impl SearchService {
    /// Reconciles the index with the meetings database. With `throttle`, skips
    /// when it ran very recently. Never waits for a sync already in progress.
    pub async fn sync<R: Runtime>(&self, app: &AppHandle<R>, throttle: bool) -> Result<usize, String> {
        let Some(state) = app.try_state::<AppState>() else { return Ok(0) };
        let Ok(_one_at_a_time) = self.sync_lock.try_lock() else { return Ok(0) };
        if throttle && self.last_sync.lock().unwrap().map_or(false, |t| t.elapsed() < SEARCH_SYNC_THROTTLE) {
            return Ok(0);
        }
        let changed = sources::sync_all(&self.index, state.db_manager.pool()).await.map_err(|e| e.to_string())?;
        *self.last_sync.lock().unwrap() = Some(Instant::now());
        if changed > 0 {
            log::info!("search: re-indexed {changed} documents");
            self.wake.notify_one();
        }
        Ok(changed)
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }

    pub async fn status(&self) -> Result<SearchStatus, String> {
        let s = self.index.status().await.map_err(|e| e.to_string())?;
        Ok(SearchStatus {
            documents: s.documents,
            chunks: s.chunks,
            embedded: s.embedded,
            model: self.model.lock().unwrap().clone(),
            index_path: self.index_path.display().to_string(),
        })
    }

    fn update_model(&self, f: impl FnOnce(&mut ModelStatus)) {
        f(&mut self.model.lock().unwrap());
    }

    async fn emit_status<R: Runtime>(&self, app: &AppHandle<R>) {
        if let Ok(status) = self.status().await {
            let _ = app.emit("search-status", status);
        }
    }

    /// Loads the model, downloading it first unless the person removed it.
    async fn prepare_model<R: Runtime>(&self, app: &AppHandle<R>) {
        let (installed, declined) = {
            let m = self.model.lock().unwrap();
            (m.installed, m.declined)
        };
        if !installed && !declined {
            if let Err(e) = self.download_model(app).await {
                log::warn!("search: embedding model download failed, keyword search only: {e}");
            }
        }
        self.load_model(app).await;
    }

    pub async fn download_model<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        {
            let mut m = self.model.lock().unwrap();
            if m.downloading {
                return Ok(());
            }
            m.downloading = true;
            m.downloaded_bytes = 0;
            m.error = None;
        }
        self.emit_status(app).await;
        let result = model::download(&self.model_dir, |done| {
            self.update_model(|m| m.downloaded_bytes = done);
            let _ = app.emit("search-model-progress", done);
        })
        .await;
        self.update_model(|m| {
            m.downloading = false;
            m.installed = DEFAULT_MODEL.is_installed(&self.model_dir);
            m.error = result.as_ref().err().cloned();
        });
        if result.is_ok() {
            let _ = self.index.set_setting(SETTING_MODEL_DECLINED, None).await;
            self.update_model(|m| m.declined = false);
        }
        self.emit_status(app).await;
        result
    }

    pub async fn load_model<R: Runtime>(&self, app: &AppHandle<R>) {
        if !DEFAULT_MODEL.is_installed(&self.model_dir) || self.index.embedder().is_some() {
            return;
        }
        let dir = self.model_dir.clone();
        // Embedder::load can panic if ONNX Runtime is missing; keyword search must survive that.
        let loaded = match tokio::task::spawn_blocking(move || Embedder::load(&dir, &DEFAULT_MODEL)).await {
            Ok(Ok(embedder)) => self.index.set_embedder(Some(Arc::new(embedder))).await.map_err(|e| e.to_string()),
            Ok(Err(e)) => Err(e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        self.update_model(|m| {
            m.loaded = loaded.is_ok();
            m.error = loaded.as_ref().err().cloned();
        });
        match loaded {
            Ok(()) => log::info!("search: embedding model {} loaded", DEFAULT_MODEL.id),
            Err(e) => log::warn!("search: embedding model failed to load, keyword search only: {e}"),
        }
        self.wake();
        self.emit_status(app).await;
    }

    /// Unloads and deletes the model, and remembers not to fetch it again.
    pub async fn remove_model<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        if self.model.lock().unwrap().downloading {
            return Err("The model is still downloading.".into());
        }
        self.index.set_embedder(None).await.map_err(|e| e.to_string())?;
        if self.model_dir.exists() {
            std::fs::remove_dir_all(&self.model_dir).map_err(|e| e.to_string())?;
        }
        let _ = self.index.set_setting(SETTING_MODEL_DECLINED, Some("1")).await;
        self.update_model(|m| {
            m.installed = false;
            m.loaded = false;
            m.declined = true;
            m.error = None;
        });
        self.emit_status(app).await;
        Ok(())
    }

    pub async fn rebuild<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        {
            let _no_sync_meanwhile = self.sync_lock.lock().await;
            self.index.clear().await.map_err(|e| e.to_string())?;
        }
        self.sync(app, false).await?;
        self.emit_status(app).await;
        Ok(())
    }

    async fn run<R: Runtime>(&self, app: &AppHandle<R>) {
        loop {
            if let Err(e) = self.sync(app, true).await {
                log::warn!("search: sync failed: {e}");
            }
            // Embedding competes with live transcription for CPU.
            if !crate::audio::recording_commands::is_recording().await {
                match self.index.embed_pending(EMBED_STEP).await {
                    Ok(0) => {}
                    Ok(_) => {
                        self.emit_status(app).await;
                        tokio::task::yield_now().await;
                        continue;
                    }
                    Err(e) => log::warn!("search: embedding failed: {e}"),
                }
            }
            let _ = tokio::time::timeout(SYNC_INTERVAL, self.wake.notified()).await;
        }
    }
}
