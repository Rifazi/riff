//! Lifecycle for the local agent server (`harness-server/`), the Node process
//! behind the Dev Sessions UI (requirements → plan → coding → QA agents).
//!
//! Started in the background at app setup, stopped on app exit. If something
//! is already listening on the port (e.g. `npm run dev` in harness-server for
//! backend work), that instance is used instead of spawning a second one.
//!
//! Shutdown is graceful: the server gets SIGTERM (its whole process group, so
//! llama-helper, agent CLIs and QA dev servers go too) and `STOP_GRACE` to
//! close, then is killed. Its stdin is a pipe from this process, and the
//! server exits when that pipe closes, so it also goes away if the app
//! crashes or is killed without running its exit handler.

use serde::Serialize;
use std::fs::{self, File};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const DEFAULT_PORT: u16 = 4319;
const MIN_NODE_MAJOR: u32 = 22;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);
const STOP_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentServerStatus {
    /// "starting" | "running" | "external" | "failed" | "stopped"
    pub state: String,
    pub url: String,
    pub message: Option<String>,
    pub server_dir: Option<String>,
    pub log_path: Option<String>,
}

impl AgentServerStatus {
    fn new(state: &str, message: Option<String>) -> Self {
        Self {
            state: state.to_string(),
            url: base_url(),
            message,
            server_dir: None,
            log_path: None,
        }
    }
}

static STATUS: Mutex<Option<AgentServerStatus>> = Mutex::new(None);
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
/// Set on app exit so a startup still in progress doesn't leave a server behind.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn port() -> u16 {
    std::env::var("HARNESS_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn base_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

fn is_listening() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port()));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn set_status<R: Runtime>(app: &AppHandle<R>, status: AgentServerStatus) {
    match status.state.as_str() {
        "failed" => log::error!("agent_server: {:?}", status.message),
        _ => log::info!("agent_server: {} {:?}", status.state, status.message),
    }
    if let Ok(mut guard) = STATUS.lock() {
        *guard = Some(status.clone());
    }
    let _ = app.emit("agent-server-status", status);
}

fn resolve_server_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = crate::brand_migration::env_var("HARNESS_SERVER_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    // Source checkout this binary was built from (dev and local builds).
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../harness-server"));
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("harness-server"));
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("backend/src/server.ts").is_file())
        .and_then(|dir| dir.canonicalize().ok())
}

fn node_major_version(node: &Path) -> Option<u32> {
    let output = Command::new(node).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// Apps launched from Finder/Explorer get a minimal PATH, and the default
/// `node` on PATH may be older than the agent server supports — so check the
/// usual install locations too and take the first recent-enough one.
fn find_node() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(explicit) = crate::brand_migration::env_var("NODE") {
        candidates.push(PathBuf::from(explicit));
    }
    for fixed in [
        "/opt/homebrew/opt/node/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/opt/node/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        candidates.push(PathBuf::from(fixed));
    }
    if let Some(home) = dirs::home_dir() {
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut nvm: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path().join("bin/node"))
                .collect();
            nvm.sort();
            nvm.reverse();
            candidates.extend(nvm);
        }
    }
    if let Ok(on_path) = which::which("node") {
        candidates.push(on_path);
    }

    let mut seen_old: Vec<String> = Vec::new();
    for candidate in candidates.into_iter().filter(|c| c.is_file()) {
        match node_major_version(&candidate) {
            Some(major) if major >= MIN_NODE_MAJOR => return Ok(candidate),
            Some(major) => seen_old.push(format!("{} (v{})", candidate.display(), major)),
            None => {}
        }
    }
    Err(if seen_old.is_empty() {
        format!("Node.js {MIN_NODE_MAJOR}+ was not found. Install it (e.g. `brew install node`) or set RIFF_NODE to its path, then restart the agent server.")
    } else {
        format!(
            "Node.js {MIN_NODE_MAJOR}+ is required but only older versions were found: {}. Install a newer Node or set RIFF_NODE.",
            seen_old.join(", ")
        )
    })
}

fn path_with_node(node: &Path) -> Option<std::ffi::OsString> {
    let node_dir = node.parent()?.to_path_buf();
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![node_dir];
    paths.extend(std::env::split_paths(&existing));
    std::env::join_paths(paths).ok()
}

fn ensure_dependencies(server_dir: &Path, node: &Path, log: &File) -> Result<(), String> {
    if server_dir.join("node_modules/tsx").is_dir() {
        return Ok(());
    }
    let npm_name = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let npm = node
        .parent()
        .map(|d| d.join(npm_name))
        .filter(|p| p.is_file())
        .or_else(|| which::which(npm_name).ok())
        .ok_or_else(|| "npm was not found next to Node.js — run `npm install` in harness-server manually.".to_string())?;

    log::info!("agent_server: installing dependencies in {}", server_dir.display());
    let mut cmd = Command::new(npm);
    cmd.arg("install").current_dir(server_dir);
    if let Some(path) = path_with_node(node) {
        cmd.env("PATH", path);
    }
    let status = cmd
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log.try_clone().map_err(|e| e.to_string())?)
        .status()
        .map_err(|e| format!("failed to run npm install: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("npm install failed in {} ({status})", server_dir.display()))
    }
}

fn spawn_server(server_dir: &Path, node: &Path, log: &File, models_dir: Option<PathBuf>) -> Result<Child, String> {
    // `--import tsx` keeps it a single process (the tsx CLI would fork a
    // child), so killing this handle on exit stops the whole server.
    let mut cmd = Command::new(node);
    cmd.args(["--import", "tsx", "src/server.ts"])
        .current_dir(server_dir.join("backend"))
        .env("HARNESS_PORT", port().to_string())
        // The server shuts down when this pipe closes (see server.ts).
        .env("HARNESS_EXIT_ON_STDIN_CLOSE", "1")
        .stdin(Stdio::piped())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log.try_clone().map_err(|e| e.to_string())?);
    if let Some(path) = path_with_node(node) {
        cmd.env("PATH", path);
    }
    // search_docs runs this binary's search engine (`--search-stdio`), the
    // same one behind the app's own search, with the same embedding model.
    if let Ok(exe) = std::env::current_exe() {
        cmd.env("RIFF_SEARCH_BIN", exe);
    }
    if let Some(dir) = models_dir {
        cmd.env("RIFF_EMBEDDING_MODELS_DIR", dir);
    }
    // Own process group, so stop() can signal everything the server spawned.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("failed to start agent server: {e}"))
}

fn start_blocking<R: Runtime>(app: &AppHandle<R>) {
    if is_listening() {
        set_status(
            app,
            AgentServerStatus::new("external", Some("Using an agent server that was already running.".into())),
        );
        return;
    }

    set_status(app, AgentServerStatus::new("starting", None));

    let Some(server_dir) = resolve_server_dir(app) else {
        set_status(
            app,
            AgentServerStatus::new(
                "failed",
                Some("harness-server directory not found. Set RIFF_HARNESS_SERVER_DIR to its path.".into()),
            ),
        );
        return;
    };

    let log_path = server_dir.join("state/agent-server.log");
    let with_paths = |mut s: AgentServerStatus| {
        s.server_dir = Some(server_dir.display().to_string());
        s.log_path = Some(log_path.display().to_string());
        s
    };

    let node = match find_node() {
        Ok(node) => node,
        Err(message) => return set_status(app, with_paths(AgentServerStatus::new("failed", Some(message)))),
    };

    let _ = fs::create_dir_all(server_dir.join("state"));
    let log = match File::create(&log_path) {
        Ok(f) => f,
        Err(e) => {
            return set_status(
                app,
                with_paths(AgentServerStatus::new("failed", Some(format!("cannot write {}: {e}", log_path.display())))),
            )
        }
    };

    if let Err(message) = ensure_dependencies(&server_dir, &node, &log) {
        return set_status(app, with_paths(AgentServerStatus::new("failed", Some(message))));
    }

    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return;
    }
    let child = match spawn_server(&server_dir, &node, &log, crate::search::embedding_models_dir(app)) {
        Ok(child) => child,
        Err(message) => return set_status(app, with_paths(AgentServerStatus::new("failed", Some(message)))),
    };
    let pid = child.id();
    // Registered before it is listening, so an exit during startup stops it.
    if let Ok(mut guard) = CHILD.lock() {
        *guard = Some(child);
    }
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return stop();
    }

    let started = Instant::now();
    loop {
        if is_listening() {
            break;
        }
        let exited = match CHILD.lock() {
            Ok(mut guard) => match guard.as_mut() {
                Some(child) if child.id() == pid => child.try_wait().ok().flatten(),
                // stop() took it (app exit or restart) — nothing more to do here.
                _ => return,
            },
            Err(_) => None,
        };
        if let Some(exit) = exited {
            if let Ok(mut guard) = CHILD.lock() {
                guard.take();
            }
            return set_status(
                app,
                with_paths(AgentServerStatus::new(
                    "failed",
                    Some(format!("agent server exited during startup ({exit}) — see {}", log_path.display())),
                )),
            );
        }
        if started.elapsed() > STARTUP_TIMEOUT {
            stop();
            return set_status(
                app,
                with_paths(AgentServerStatus::new(
                    "failed",
                    Some(format!("agent server did not start listening in time — see {}", log_path.display())),
                )),
            );
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    set_status(
        app,
        with_paths(AgentServerStatus::new("running", Some(format!("Using Node {}", node.display())))),
    );
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || start_blocking(&app));
}

/// Stops the server this app started (an external one is left alone).
pub fn stop() {
    let child = CHILD.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        terminate(&mut child);
    }
}

/// Stops the server for good at app exit, including one still starting up.
pub fn shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    stop();
}

fn terminate(child: &mut Child) {
    let pid = child.id();
    log::info!("agent_server: stopping (pid {pid})");
    // Closing stdin asks the server to shut down; SIGTERM does the same and
    // also reaches whatever it spawned.
    drop(child.stdin.take());
    #[cfg(unix)]
    signal_group(pid, libc::SIGTERM);

    let deadline = Instant::now() + STOP_GRACE;
    let mut exited = false;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                log::info!("agent_server: stopped ({status})");
                exited = true;
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    if !exited {
        log::warn!("agent_server: did not stop within {STOP_GRACE:?}, killing it");
    }
    // Also clears out anything it spawned that is still running.
    #[cfg(unix)]
    signal_group(pid, libc::SIGKILL);
    if !exited {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) {
    // The server leads its own process group (see spawn_server), so the
    // group id is its pid.
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
    }
}

#[tauri::command]
pub fn get_agent_server_status() -> AgentServerStatus {
    STATUS
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .unwrap_or_else(|| AgentServerStatus::new("stopped", None))
}

#[tauri::command]
pub async fn restart_agent_server<R: Runtime>(app: AppHandle<R>) -> Result<AgentServerStatus, String> {
    stop();
    tauri::async_runtime::spawn_blocking(move || {
        // Give the OS a moment to release the port after the kill.
        let released = Instant::now();
        while is_listening() && released.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(100));
        }
        start_blocking(&app);
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(get_agent_server_status())
}

/// Native folder picker for choosing an app's repository checkout.
#[tauri::command]
pub async fn pick_app_repo_folder<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Choose the app's repository folder").blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked.map(|p| p.to_string()))
}
