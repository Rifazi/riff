//! One-time move of data left behind by the app's former name, Meetily.
//!
//! The rebrand to Riff changed the bundle identifier (`com.meetily.ai` →
//! `com.rifaz.riff`) and the product name, which changes every per-app
//! directory that Tauri, the webview and our own code resolve. This runs before
//! the Tauri builder so nothing has opened the new locations yet.
//!
//! Each directory is renamed rather than copied (same parent, so it is instant
//! even with gigabytes of models) and only when the old one exists and the new
//! one doesn't — anything else is left untouched and logged.

use std::path::{Path, PathBuf};

const LEGACY_IDENTIFIER: &str = "com.meetily.ai";
/// Must match `identifier` in tauri.conf.json.
const IDENTIFIER: &str = "com.rifaz.riff";

pub fn migrate_legacy_data() {
    for (old, new) in legacy_dir_pairs() {
        migrate_dir(&old, &new);
    }
}

fn legacy_dir_pairs() -> Vec<(PathBuf, PathBuf)> {
    let mut pairs = Vec::new();
    let mut push = |base: Option<PathBuf>, old: &str, new: &str| {
        if let Some(base) = base {
            pairs.push((base.join(old), base.join(new)));
        }
    };

    // Tauri's app_data_dir / app_local_data_dir / app_config_dir: database,
    // models, stores, and on Windows the WebView2 profile (local data dir).
    // On macOS these are all the same directory; repeats are no-ops.
    push(dirs::data_dir(), LEGACY_IDENTIFIER, IDENTIFIER);
    push(dirs::data_local_dir(), LEGACY_IDENTIFIER, IDENTIFIER);
    push(dirs::config_dir(), LEGACY_IDENTIFIER, IDENTIFIER);

    // Directories our own code named after the product: custom summary
    // templates and model fallbacks, and notification settings.
    push(dirs::data_dir(), "Meetily", "Riff");
    push(dirs::config_dir(), "meetily", "riff");

    // WKWebView website data (localStorage, the IndexedDB recovery store).
    #[cfg(target_os = "macos")]
    push(
        dirs::home_dir().map(|home| home.join("Library").join("WebKit")),
        LEGACY_IDENTIFIER,
        IDENTIFIER,
    );

    pairs
}

fn migrate_dir(old: &Path, new: &Path) {
    if !old.is_dir() {
        return;
    }
    if new.exists() {
        log::warn!(
            "brand_migration: not moving {} → {}: destination already exists",
            old.display(),
            new.display()
        );
        return;
    }
    match std::fs::rename(old, new) {
        Ok(()) => log::info!(
            "brand_migration: moved {} → {}",
            old.display(),
            new.display()
        ),
        Err(e) => log::error!(
            "brand_migration: failed to move {} → {}: {}",
            old.display(),
            new.display(),
            e
        ),
    }
}

/// Reads `RIFF_<suffix>`, falling back to the pre-rebrand `MEETILY_<suffix>`
/// so existing shell setups keep working.
pub fn env_var(suffix: &str) -> Result<String, std::env::VarError> {
    std::env::var(format!("RIFF_{suffix}")).or_else(|_| std::env::var(format!("MEETILY_{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_old_dir_when_new_is_absent() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join(LEGACY_IDENTIFIER);
        let new = root.path().join(IDENTIFIER);
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("meeting_minutes.sqlite"), b"db").unwrap();

        migrate_dir(&old, &new);

        assert!(!old.exists());
        assert_eq!(std::fs::read(new.join("meeting_minutes.sqlite")).unwrap(), b"db");
    }

    #[test]
    fn leaves_both_alone_when_new_exists() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join(LEGACY_IDENTIFIER);
        let new = root.path().join(IDENTIFIER);
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        std::fs::write(new.join("keep"), b"new").unwrap();

        migrate_dir(&old, &new);

        assert!(old.exists());
        assert_eq!(std::fs::read(new.join("keep")).unwrap(), b"new");
    }

    #[test]
    fn missing_old_dir_is_a_no_op() {
        let root = tempfile::tempdir().unwrap();
        let new = root.path().join(IDENTIFIER);

        migrate_dir(&root.path().join(LEGACY_IDENTIFIER), &new);

        assert!(!new.exists());
    }
}
