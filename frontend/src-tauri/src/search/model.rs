//! Fetches the embedding model's files, each checked against its pinned SHA-256.

use futures_util::StreamExt;
use riff_search::{verify_sha256, DEFAULT_MODEL};
use std::path::Path;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

const PROGRESS_EVERY: Duration = Duration::from_millis(250);

/// Downloads whatever is missing into `dir`, reporting total bytes done.
pub async fn download(dir: &Path, progress: impl Fn(u64)) -> Result<(), String> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut done_before: u64 = 0;
    let mut last_report = Instant::now();

    for file in DEFAULT_MODEL.files {
        let target = dir.join(file.name);
        if target.metadata().map_or(false, |m| m.len() == file.size) {
            done_before += file.size;
            continue;
        }
        let part = dir.join(format!("{}.part", file.name));
        let response = client
            .get(file.url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("downloading {}: {e}", file.name))?;
        let mut out = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
        let mut done: u64 = 0;
        let mut stream = response.bytes_stream();
        while let Some(bytes) = stream.next().await {
            let bytes = bytes.map_err(|e| format!("downloading {}: {e}", file.name))?;
            out.write_all(&bytes).await.map_err(|e| e.to_string())?;
            done += bytes.len() as u64;
            if last_report.elapsed() >= PROGRESS_EVERY {
                progress(done_before + done);
                last_report = Instant::now();
            }
        }
        out.flush().await.map_err(|e| e.to_string())?;
        drop(out);

        let (part_check, sha) = (part.clone(), file.sha256);
        let ok = tokio::task::spawn_blocking(move || verify_sha256(&part_check, sha))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        if !ok || done != file.size {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(format!("{} failed its integrity check; try again", file.name));
        }
        tokio::fs::rename(&part, &target).await.map_err(|e| e.to_string())?;
        done_before += file.size;
        progress(done_before);
    }
    Ok(())
}
