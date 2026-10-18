//! Remote control: lets the Riff phone app (the same Next.js views, built with
//! `RIFF_MOBILE=1`) drive this desktop app over Tailscale.
//!
//! Tauri commands can't be called by name from Rust, so the desktop webview is
//! the executor: a phone request becomes a `remote-invoke` event, the webview
//! runs the real `invoke()` and answers through `remote_reply`. Events flow the
//! other way the same way (`remote-subscribe` → `remote_event`). The desktop
//! window therefore has to be open (it may be hidden).
//!
//! Security: off by default; listens only on this Mac's Tailscale address(es), or
//! on its Wi-Fi/LAN address when the user picks that in Settings → Phone
//! (`RIFF_REMOTE_BIND` overrides both, for tests); everything but the static UI
//! bundle needs the pairing token. The agent-server proxy sends no `Origin`, so
//! the server's origin check is left as it is.

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, net::IpAddr, path::PathBuf, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, oneshot, Mutex};
use tower_http::services::ServeDir;

const DEFAULT_PORT: u16 = 4320;
const AGENT_SERVER: &str = "http://127.0.0.1:4319";
/// Commands that only make sense at the Mac itself or would let a phone change
/// how the bridge (or the app) is set up.
const DENIED: &[&str] = &[
    "remote_set_enabled",
    "remote_set_network",
    "remote_rotate_token",
    "remote_info",
    "pick_app_repo_folder",
    "restart_agent_server",
];

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    /// Reachable anywhere the phone has Tailscale.
    #[default]
    Tailscale,
    /// Reachable only from the same Wi-Fi/LAN as this Mac.
    Lan,
}

#[derive(Serialize, Deserialize, Clone)]
struct Settings {
    enabled: bool,
    port: u16,
    token: String,
    #[serde(default)]
    network: Network,
}

/// What the server is doing right now, for Settings → Phone.
#[derive(Default, Clone)]
struct ListenStatus {
    listening: Vec<String>,
    error: Option<String>,
}

pub struct RemoteState {
    app: AppHandle<tauri::Wry>,
    settings: Mutex<Settings>,
    events: broadcast::Sender<String>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    server: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    status: Mutex<ListenStatus>,
}

type Shared = Arc<RemoteState>;

fn settings_path(app: &AppHandle<tauri::Wry>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("remote.json"))
}

fn new_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn load(app: &AppHandle<tauri::Wry>) -> Settings {
    settings_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .unwrap_or(Settings { enabled: false, port: DEFAULT_PORT, token: new_token(), network: Network::default() })
}

fn save(app: &AppHandle<tauri::Wry>, s: &Settings) {
    let Some(p) = settings_path(app) else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, serde_json::to_vec_pretty(s).unwrap_or_default());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
}

/// Constant-time, so a wrong token can't be guessed a byte at a time.
fn token_ok(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorized(headers: &HeaderMap, query: &HashMap<String, String>, expected: &str) -> bool {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    bearer.or(query.get("token").map(String::as_str)).is_some_and(|t| token_ok(t, expected))
}

const TAILSCALE_BINARIES: [&str; 2] = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

fn tailscale_installed() -> bool {
    std::path::Path::new("/Applications/Tailscale.app").exists()
        || TAILSCALE_BINARIES
            .iter()
            .any(|bin| std::process::Command::new(bin).arg("version").output().is_ok_and(|o| o.status.success()))
}

/// This Mac's Tailscale IPv4 addresses (empty when Tailscale is missing, signed out or stopped).
fn tailscale_hosts() -> Vec<IpAddr> {
    for bin in TAILSCALE_BINARIES {
        if let Ok(out) = std::process::Command::new(bin).args(["ip", "-4"]).output() {
            let ips: Vec<IpAddr> =
                String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect();
            if !ips.is_empty() {
                return ips;
            }
        }
    }
    Vec::new()
}

/// The address this Mac uses on its local network. Connecting a UDP socket sends nothing; it only picks the route.
fn lan_host() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

fn bind_addresses(network: Network) -> Vec<IpAddr> {
    if let Ok(v) = std::env::var("RIFF_REMOTE_BIND") {
        return v.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    }
    match network {
        Network::Tailscale => tailscale_hosts(),
        Network::Lan => lan_host().into_iter().collect(),
    }
}

pub fn start(app: &AppHandle<tauri::Wry>) {
    let settings = load(app);
    save(app, &settings);
    let (events, _) = broadcast::channel(256);
    let state: Shared = Arc::new(RemoteState {
        app: app.clone(),
        settings: Mutex::new(settings.clone()),
        events,
        pending: Mutex::new(HashMap::new()),
        server: Mutex::new(None),
        status: Mutex::new(ListenStatus::default()),
    });
    app.manage(state.clone());
    if settings.enabled {
        tauri::async_runtime::spawn(restart_server(state));
    }
}

/// (Re)starts the listener, first stopping any earlier one. When the chosen network has no address yet
/// (Tailscale still starting, signed out, Wi-Fi off) it keeps looking and starts as soon as one appears.
async fn restart_server(shared: Shared) {
    let mut slot = shared.server.lock().await;
    if let Some(old) = slot.take() {
        old.abort();
    }
    *shared.status.lock().await = ListenStatus::default();
    let task_shared = shared.clone();
    *slot = Some(tauri::async_runtime::spawn(async move {
        let shared = task_shared;
        let (port, network) = {
            let s = shared.settings.lock().await;
            (s.port, s.network)
        };
        let addrs = loop {
            let addrs = bind_addresses(network);
            if !addrs.is_empty() {
                break addrs;
            }
            shared.status.lock().await.error = Some(match network {
                Network::Tailscale => "Waiting for Tailscale to connect on this Mac…".to_string(),
                Network::Lan => "This Mac isn't on a network right now.".to_string(),
            });
            tokio::time::sleep(Duration::from_secs(4)).await;
        };
        let ui_dir = std::env::var("RIFF_MOBILE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../out-mobile"));
        let router = Router::new()
            .route("/ws", get(ws_handler))
            .route("/agent/*path", any(agent_proxy))
            .fallback_service(ServeDir::new(ui_dir).append_index_html_on_directories(true))
            .with_state(shared.clone());

        // Dropping the JoinSet (when this task is aborted) stops every listener.
        let mut tasks = tokio::task::JoinSet::new();
        let mut status = ListenStatus::default();
        for ip in addrs {
            match tokio::net::TcpListener::bind((ip, port)).await {
                Ok(listener) => {
                    log::info!("remote: listening on {ip}:{port}");
                    status.listening.push(ip.to_string());
                    let router = router.clone();
                    tasks.spawn(async move {
                        let _ = axum::serve(listener, router).await;
                    });
                }
                Err(e) => {
                    log::error!("remote: can't listen on {ip}:{port}: {e}");
                    status.error = Some(format!("Can't listen on {ip}:{port}: {e}"));
                }
            }
        }
        if !status.listening.is_empty() {
            status.error = None;
        }
        *shared.status.lock().await = status;
        while tasks.join_next().await.is_some() {}
    }));
}

async fn ws_handler(
    State(shared): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let expected = shared.settings.lock().await.token.clone();
    if !authorized(&headers, &q, &expected) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| client(socket, shared))
}

async fn client(socket: WebSocket, shared: Shared) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut events = shared.events.subscribe();

    let forward = tokio::spawn({
        let out_tx = out_tx.clone();
        async move {
            while let Ok(ev) = events.recv().await {
                if out_tx.send(ev).is_err() {
                    break;
                }
            }
        }
    });
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if sink.send(Message::Text(m)).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if let Some(names) = v.get("subscribe") {
            let _ = shared.app.emit("remote-subscribe", names);
            continue;
        }
        let (Some(id), Some(cmd)) =
            (v.get("id").and_then(Value::as_str), v.get("cmd").and_then(Value::as_str))
        else {
            continue;
        };
        let (id, cmd) = (id.to_string(), cmd.to_string());
        let args = v.get("args").cloned().unwrap_or(Value::Null);
        let out_tx = out_tx.clone();
        let shared = shared.clone();
        tokio::spawn(async move {
            let mut reply = if DENIED.contains(&cmd.as_str()) {
                json!({ "ok": false, "error": format!("{cmd} can only be run on the Mac") })
            } else {
                let (tx, rx) = oneshot::channel();
                shared.pending.lock().await.insert(id.clone(), tx);
                let _ = shared.app.emit("remote-invoke", json!({ "id": id, "cmd": cmd, "args": args }));
                match tokio::time::timeout(Duration::from_secs(600), rx).await {
                    Ok(Ok(r)) => r,
                    _ => {
                        shared.pending.lock().await.remove(&id);
                        json!({ "ok": false, "error": "The Mac didn't answer. Is the Riff window open?" })
                    }
                }
            };
            reply["id"] = json!(id);
            let _ = out_tx.send(reply.to_string());
        });
    }
    forward.abort();
    writer.abort();
}

/// Streams the agent server's responses (including SSE) through to the phone.
async fn agent_proxy(
    State(shared): State<Shared>,
    Path(path): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let expected = shared.settings.lock().await.token.clone();
    if !authorized(&headers, &q, &expected) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let rest: Vec<(&String, &String)> = q.iter().filter(|(k, _)| k.as_str() != "token").collect();
    let Ok(bytes) = axum::body::to_bytes(body, 32 * 1024 * 1024).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let mut req = reqwest::Client::new()
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            format!("{AGENT_SERVER}/{path}"),
        )
        .query(&rest)
        .body(bytes);
    if let Some(ct) = headers.get(header::CONTENT_TYPE) {
        req = req.header("content-type", ct.as_bytes());
    }
    match req.send().await {
        Ok(up) => {
            let mut out = Response::builder().status(up.status().as_u16());
            for (k, v) in up.headers() {
                if !matches!(k.as_str(), "content-length" | "transfer-encoding") {
                    out = out.header(k.as_str(), v.as_bytes());
                }
            }
            out.body(Body::from_stream(up.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
        }
        Err(e) => (StatusCode::BAD_GATEWAY, format!("agent server unreachable: {e}")).into_response(),
    }
}

#[tauri::command]
pub async fn remote_reply(
    state: tauri::State<'_, Shared>,
    id: String,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(tx) = state.pending.lock().await.remove(&id) {
        let _ = tx.send(if ok {
            json!({ "ok": true, "value": value })
        } else {
            json!({ "ok": false, "error": error })
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_event(state: tauri::State<'_, Shared>, name: String, payload: Value) -> Result<(), String> {
    let _ = state.events.send(json!({ "event": name, "payload": payload }).to_string());
    Ok(())
}

#[derive(Serialize)]
pub struct RemoteInfo {
    enabled: bool,
    port: u16,
    token: String,
    network: Network,
    /// "not_installed" | "not_connected" | "ready"
    tailscale: &'static str,
    lan_available: bool,
    /// Addresses the phone can use right now (empty until the server is listening).
    hosts: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn remote_info(state: tauri::State<'_, Shared>) -> Result<RemoteInfo, String> {
    let s = state.settings.lock().await.clone();
    let status = state.status.lock().await.clone();
    // Probing runs external commands, so keep it off the async worker.
    let (tailscale, lan_available) = tokio::task::spawn_blocking(|| {
        let ts = if !tailscale_installed() {
            "not_installed"
        } else if tailscale_hosts().is_empty() {
            "not_connected"
        } else {
            "ready"
        };
        (ts, lan_host().is_some())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(RemoteInfo {
        enabled: s.enabled,
        port: s.port,
        token: s.token,
        network: s.network,
        tailscale,
        lan_available,
        hosts: status.listening,
        error: status.error,
    })
}

#[tauri::command]
pub async fn remote_set_enabled(state: tauri::State<'_, Shared>, enabled: bool) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().await;
        s.enabled = enabled;
        s.clone()
    };
    save(&state.app, &snapshot);
    if enabled {
        restart_server(state.inner().clone()).await;
    } else {
        if let Some(h) = state.server.lock().await.take() {
            h.abort();
        }
        *state.status.lock().await = ListenStatus::default();
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_set_network(state: tauri::State<'_, Shared>, network: Network) -> Result<(), String> {
    let snapshot = {
        let mut s = state.settings.lock().await;
        s.network = network;
        s.clone()
    };
    save(&state.app, &snapshot);
    if snapshot.enabled {
        restart_server(state.inner().clone()).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_rotate_token(state: tauri::State<'_, Shared>) -> Result<String, String> {
    let snapshot = {
        let mut s = state.settings.lock().await;
        s.token = new_token();
        s.clone()
    };
    save(&state.app, &snapshot);
    Ok(snapshot.token)
}
