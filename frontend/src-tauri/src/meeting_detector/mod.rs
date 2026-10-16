//! Starts and stops recording by itself when a meeting app is on a call.
//!
//! A task polls which processes are capturing microphone audio. When an app the
//! user enabled (Settings → Recordings) holds the mic for a few seconds it
//! starts a recording, and it stops that recording once the app has let go of
//! the mic for a while. It never touches a recording the user started, and the
//! frontend finishes the meeting (save, summary, journals) from the same
//! `recording-stop-complete` event the tray uses, so the window can stay hidden.

pub mod apps;
mod core;
#[cfg(target_os = "macos")]
mod coreaudio_macos;

use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
pub fn spawn<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(watch(app));
}

#[cfg(not(target_os = "macos"))]
pub fn spawn<R: Runtime>(_app: AppHandle<R>) {}

#[cfg(target_os = "macos")]
async fn watch<R: Runtime>(app: AppHandle<R>) {
    use self::core::{Action, Detector, Timing};
    use std::time::{Duration, Instant};

    let mut detector = Detector::new(Timing::default());
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;

        let prefs = crate::audio::recording_preferences::peek_recording_preferences(&app);
        let enabled_keys: &[String] = match &prefs {
            Some(p) if p.auto_record_meetings => &p.auto_record_apps,
            _ => {
                detector.reset();
                continue;
            }
        };

        let active = coreaudio_macos::input_bundle_ids()
            .iter()
            .filter_map(|id| apps::match_bundle_id(id))
            .find(|app| enabled_keys.iter().any(|key| key == app.key))
            .map(|app| app.key);
        let recording = crate::audio::recording_commands::is_recording().await;

        match detector.tick(Instant::now(), active, recording) {
            Action::None => {}
            Action::Start(key) => {
                if let Err(e) = start(&app, key, prefs.as_ref()).await {
                    log::error!("meeting_detector: couldn't start recording for {key}: {e}");
                    detector.start_failed(Instant::now());
                }
            }
            Action::Stop => {
                if let Err(e) = stop(&app).await {
                    log::error!("meeting_detector: couldn't stop recording: {e}");
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
async fn start<R: Runtime>(
    app: &AppHandle<R>,
    key: &str,
    prefs: Option<&crate::audio::recording_preferences::RecordingPreferences>,
) -> Result<(), String> {
    let name = apps::app_by_key(key).map_or("Meeting", |a| a.name);
    let title = format!("{} call {}", name, chrono::Local::now().format("%b %-d, %H:%M"));
    log::info!("meeting_detector: {name} is on a call, starting recording \"{title}\"");

    crate::start_recording(
        app.clone(),
        prefs.and_then(|p| p.preferred_mic_device.clone()),
        prefs.and_then(|p| p.preferred_system_device.clone()),
        Some(title),
    )
    .await
}

#[cfg(target_os = "macos")]
async fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    log::info!("meeting_detector: call ended, stopping recording");
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
    let save_path = data_dir.join(format!("recording-{timestamp}.wav"));

    crate::stop_recording(
        app.clone(),
        crate::RecordingArgs {
            save_path: save_path.to_string_lossy().to_string(),
        },
    )
    .await?;

    // The frontend saves the meeting and files it into journals on this event.
    app.emit("recording-stop-complete", true)
        .map_err(|e| e.to_string())
}
