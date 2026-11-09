use std::path::{Path, PathBuf};

use log::info;

/// The agent server only ever listens on loopback; refusing anything else keeps
/// this command from being a way to write arbitrary downloads to disk.
const SERVER_PREFIX: &str = "http://127.0.0.1:";

fn clean_file_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("presentation.pptx");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ') { c } else { '-' })
        .collect();
    if cleaned.to_lowercase().ends_with(".pptx") {
        cleaned
    } else {
        format!("{}.pptx", cleaned)
    }
}

/// "name.pptx", then "name (2).pptx", ... so an earlier download is never overwritten.
fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = file_name.trim_end_matches(".pptx");
    (2..)
        .map(|n| dir.join(format!("{} ({}).pptx", stem, n)))
        .find(|p| !p.exists())
        .expect("unbounded range")
}

fn reveal(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn();
    #[cfg(target_os = "linux")]
    if let Some(dir) = path.parent() {
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
}

/// Downloads a generated presentation from the local agent server into the
/// user's Downloads folder and shows it there. Returns the saved path.
#[tauri::command]
pub async fn save_deck_to_downloads(url: String, file_name: String) -> Result<String, String> {
    if !url.starts_with(SERVER_PREFIX) {
        return Err("Not an agent server URL".to_string());
    }
    let dir = dirs::download_dir().ok_or("Could not find the Downloads folder")?;
    let bytes = reqwest::get(&url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Could not download the presentation: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Could not download the presentation: {}", e))?;
    let path = unique_path(&dir, &clean_file_name(&file_name));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("Could not save {}: {}", path.display(), e))?;
    info!("Saved presentation to {}", path.display());
    reveal(&path);
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_lose_paths_and_gain_extension() {
        assert_eq!(clean_file_name("../../etc/passwd"), "passwd.pptx");
        assert_eq!(clean_file_name("Q3 plan.pptx"), "Q3 plan.pptx");
        assert_eq!(clean_file_name("a/b:c"), "b-c.pptx");
    }
}
