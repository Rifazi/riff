//! Which processes are capturing from an input device right now.
//!
//! The per-process flag (`kAudioProcessPropertyIsRunningInput`, macOS 14.2+)
//! is used rather than the device-level "running somewhere" flag, because the
//! latter is always true once Riff itself records the microphone.

use cidre::core_audio as ca;
use std::sync::atomic::{AtomicBool, Ordering};

static WARNED_UNSUPPORTED: AtomicBool = AtomicBool::new(false);

/// Bundle IDs of every process currently running audio input.
pub fn input_bundle_ids() -> Vec<String> {
    let processes = match ca::System::processes() {
        Ok(processes) => processes,
        Err(e) => {
            if !WARNED_UNSUPPORTED.swap(true, Ordering::Relaxed) {
                log::warn!(
                    "meeting_detector: can't list audio processes ({e:?}); \
                     auto-record needs macOS 14.2 or later"
                );
            }
            return Vec::new();
        }
    };

    processes
        .iter()
        .filter(|p| p.is_running_input().unwrap_or(false))
        .filter_map(|p| p.bundle_id().ok().map(|id| id.to_string()))
        .collect()
}
