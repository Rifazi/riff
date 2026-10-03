# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Riff** (formerly Meetily; named for its maker, Rifaz Iqbal) is a privacy-first AI meeting assistant that captures, transcribes, and summarizes meetings entirely on local infrastructure. The supported application is the Tauri desktop app with a Rust core.

1. **Frontend**: Tauri-based desktop application (Rust + Next.js + TypeScript)
2. **Rust Backend**: Tauri commands, audio capture, transcription, storage, and summarization orchestration
3. **Dev Sessions agent server** (`harness-server/`): local Node/Fastify server behind the Dev Sessions UI — requirements → plan → coding → QA agents that turn a meeting transcript (or a typed idea) into a requirements doc, plan, branch and QA report for a configured target repo ("app"). Started automatically by the Tauri app
4. **Legacy Backend Archive**: the old Python/FastAPI, Docker, and standalone whisper-server backend under `backend/` is archived and unsupported

### Key Technology Stack
- **Desktop App**: Tauri 2.x (Rust) + Next.js 14 + React 18
- **Audio Processing**: Rust (cpal, whisper-rs, professional audio mixing)
- **Transcription**: Whisper.cpp / whisper-rs and Parakeet paths in the Tauri app
- **App API Surface**: Tauri commands and events, not a separate FastAPI service
- **LLM Integration**: Ollama (local), Claude, Groq, OpenRouter

## Essential Development Commands

### Frontend Development (Tauri Desktop App)

**Location**: `/frontend`

```bash
# macOS Development
./clean_run.sh              # Clean build and run with info logging
./clean_run.sh debug        # Run with debug logging
./clean_build.sh            # Production build

# Windows Development
clean_run_windows.bat       # Clean build and run
clean_build_windows.bat     # Production build

# Manual Commands
pnpm install                # Install dependencies
pnpm run dev                # Next.js dev server (port 3118)
pnpm run tauri:dev          # Full Tauri development mode
pnpm run tauri:build        # Production build

# GPU-Specific Builds (for testing acceleration)
pnpm run tauri:dev:metal    # macOS Metal GPU
pnpm run tauri:dev:cuda     # NVIDIA CUDA
pnpm run tauri:dev:vulkan   # AMD/Intel Vulkan
pnpm run tauri:dev:cpu      # CPU-only (no GPU)
```

### Legacy Backend Archive

**Location**: `/backend`

The Python/FastAPI backend, Docker setup, and standalone whisper-server scripts are archived for historical reference and migration context only. Do not use them for current development, new installs, production deployments, or issue triage for the supported app.

The archived FastAPI service had unauthenticated, development-oriented CORS behavior. Treat that behavior as obsolete legacy context, not as a supported production API.

### Service Endpoints
- **Frontend Dev**: http://localhost:3118

## High-Level Architecture

### Tauri Desktop Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (Tauri Desktop App)                  │
│  ┌──────────────────┐  ┌─────────────────┐  ┌────────────────┐ │
│  │   Next.js UI     │  │  Rust Backend   │  │ Whisper Engine │ │
│  │  (React/TS)      │←→│  (Audio + IPC)  │←→│  (Local STT)   │ │
│  └──────────────────┘  └─────────────────┘  └────────────────┘ │
│         ↑ Tauri Events           ↑ Audio Pipeline               │
└─────────────────────────────────────────────────────────────────┘
```

The current app does not require a separate FastAPI tier. Meeting persistence, local transcription, and summary orchestration are handled through the Rust/Tauri core.

### Audio Processing Pipeline (Critical Understanding)

The audio system has **two parallel paths** with different purposes:

```
Raw Audio (Mic + System)
         ↓
┌────────────────────────────────────────────────────────────┐
│              Audio Pipeline Manager                         │
│  (frontend/src-tauri/src/audio/pipeline.rs)                │
└─────────────┬──────────────────────────┬───────────────────┘
              ↓                          ↓
    ┌─────────────────┐        ┌─────────────────────┐
    │ Recording Path  │        │ Transcription Path  │
    │ (Pre-mixed)     │        │ (VAD-filtered)      │
    └─────────────────┘        └─────────────────────┘
              ↓                          ↓
    RecordingSaver.save()      WhisperEngine.transcribe()
```

**Key Insight**: The pipeline performs **professional audio mixing** (RMS-based ducking, clipping prevention) for recording, while simultaneously applying **Voice Activity Detection (VAD)** to send only speech segments to Whisper for transcription.

### Audio Device Modularization (Recently Completed)

**Context**: The audio system was refactored from a monolithic 1028-line `core.rs` file into focused modules. See [AUDIO_MODULARIZATION_PLAN.md](AUDIO_MODULARIZATION_PLAN.md) for details.

```
audio/
├── devices/                    # Device discovery and configuration
│   ├── discovery.rs           # list_audio_devices, trigger_audio_permission
│   ├── microphone.rs          # default_input_device
│   ├── speakers.rs            # default_output_device
│   ├── configuration.rs       # AudioDevice types, parsing
│   └── platform/              # Platform-specific implementations
│       ├── windows.rs         # WASAPI logic (~200 lines)
│       ├── macos.rs           # ScreenCaptureKit logic
│       └── linux.rs           # ALSA/PulseAudio logic
├── capture/                   # Audio stream capture
│   ├── microphone.rs          # Microphone capture stream
│   ├── system.rs              # System audio capture stream
│   └── core_audio.rs          # macOS ScreenCaptureKit integration
├── pipeline.rs                # Audio mixing and VAD processing
├── recording_manager.rs       # High-level recording coordination
├── recording_commands.rs      # Tauri command interface
└── recording_saver.rs         # Audio file writing
```

**When working on audio features**:
- Device detection issues → `devices/discovery.rs` or `devices/platform/{windows,macos,linux}.rs`
- Microphone/speaker problems → `devices/microphone.rs` or `devices/speakers.rs`
- Audio capture issues → `capture/microphone.rs` or `capture/system.rs`
- Mixing/processing problems → `pipeline.rs`
- Recording workflow → `recording_manager.rs`

### Rust ↔ Frontend Communication (Tauri Architecture)

**Command Pattern** (Frontend → Rust):
```typescript
// Frontend: src/app/page.tsx
await invoke('start_recording', {
  mic_device_name: "Built-in Microphone",
  system_device_name: "BlackHole 2ch",
  meeting_name: "Team Standup"
});
```

```rust
// Rust: src/lib.rs
#[tauri::command]
async fn start_recording<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>
) -> Result<(), String> {
    // Implementation delegates to audio::recording_commands
}
```

**Event Pattern** (Rust → Frontend):
```rust
// Rust: Emit transcript updates
app.emit("transcript-update", TranscriptUpdate {
    text: "Hello world".to_string(),
    timestamp: chrono::Utc::now(),
    // ...
})?;
```

```typescript
// Frontend: Listen for events
await listen<TranscriptUpdate>('transcript-update', (event) => {
  setTranscripts(prev => [...prev, event.payload]);
});
```

### Whisper Model Management

**Model Storage Locations**:
- **Development**: `frontend/models/`
- **Production (macOS)**: `~/Library/Application Support/com.rifaz.riff/models/`
- **Production (Windows)**: `%APPDATA%\com.rifaz.riff\models\`

**Model Loading** (frontend/src-tauri/src/whisper_engine/whisper_engine.rs):
```rust
pub async fn load_model(&self, model_name: &str) -> Result<()> {
    // Automatically detects GPU capabilities (Metal/CUDA/Vulkan)
    // Falls back to CPU if GPU unavailable
}
```

**GPU Acceleration**:
- **macOS**: Metal + CoreML (automatically enabled)
- **Windows/Linux**: CUDA (NVIDIA), Vulkan (AMD/Intel), or CPU
- Configure via Cargo features: `--features cuda`, `--features vulkan`

## Critical Development Patterns

### 1. Audio Buffer Management

**Ring Buffer Mixing** (pipeline.rs):
- Mic and system audio arrive asynchronously at different rates
- Ring buffer accumulates samples until both streams have aligned windows (50ms)
- Professional mixing applies RMS-based ducking to prevent system audio from drowning out microphone
- Uses `VecDeque` for efficient windowed processing

### 2. Thread Safety and Async Boundaries

**Recording State** (recording_state.rs):
```rust
pub struct RecordingState {
    is_recording: Arc<AtomicBool>,
    audio_sender: Arc<RwLock<Option<mpsc::UnboundedSender<AudioChunk>>>>,
    // ...
}
```

**Key Pattern**: Use `Arc<RwLock<T>>` for shared state across async tasks, `Arc<AtomicBool>` for simple flags.

### 3. Error Handling and Logging

**Performance-Aware Logging** (lib.rs):
```rust
#[cfg(debug_assertions)]
macro_rules! perf_debug {
    ($($arg:tt)*) => { log::debug!($($arg)*) };
}

#[cfg(not(debug_assertions))]
macro_rules! perf_debug {
    ($($arg:tt)*) => {};  // Zero overhead in release builds
}
```

**Usage**: Use `perf_debug!()` and `perf_trace!()` for hot-path logging that should be eliminated in production.

### 4. Frontend State Management

**Sidebar Context** (components/Sidebar/SidebarProvider.tsx):
- Global state for meetings list, current meeting, recording status
- Communicates with the Rust/Tauri core through Tauri commands and events
- Keeps React state synchronized with native recording, meeting, transcript, and summary state

**Pattern**: Tauri commands update Rust state → Emit events → Frontend listeners update React state → Context propagates to components

## Common Development Tasks

### Adding a New Audio Device Platform

1. Create platform file: `audio/devices/platform/{platform_name}.rs`
2. Implement device enumeration for the platform
3. Add platform-specific configuration in `audio/devices/configuration.rs`
4. Update `audio/devices/platform/mod.rs` to export new platform functions
5. Test with `cargo check` and platform-specific device tests

### Adding a New Tauri Command

1. Define command in `src/lib.rs`:
   ```rust
   #[tauri::command]
   async fn my_command(arg: String) -> Result<String, String> { /* ... */ }
   ```
2. Register in `tauri::Builder`:
   ```rust
   .invoke_handler(tauri::generate_handler![
       start_recording,
       my_command,  // Add here
   ])
   ```
3. Call from frontend:
   ```typescript
   const result = await invoke<string>('my_command', { arg: 'value' });
   ```

### Modifying Audio Pipeline Behavior

**Location**: `frontend/src-tauri/src/audio/pipeline.rs`

Key components:
- `AudioMixerRingBuffer`: Manages mic + system audio synchronization
- `ProfessionalAudioMixer`: RMS-based ducking and mixing
- `AudioPipelineManager`: Orchestrates VAD, mixing, and distribution

**Testing Audio Changes**:
```bash
# Enable verbose audio logging
RUST_LOG=app_lib::audio=debug ./clean_run.sh

# Monitor audio metrics in real-time
# Check Developer Console in the app (Cmd+Shift+I on macOS)
```

### Tauri Backend Development

Current app behavior should be implemented in the Rust/Tauri core, not in the archived Python backend. Add new frontend-facing behavior through Tauri commands/events and existing Rust services under `frontend/src-tauri/src`.

Do not add new endpoints to `backend/app/main.py`; that FastAPI code is legacy archive material only.

## Testing and Debugging

### Frontend Debugging

**Enable Rust Logging**:
```bash
# macOS
RUST_LOG=debug ./clean_run.sh

# Windows (PowerShell)
$env:RUST_LOG="debug"; ./clean_run_windows.bat
```

**Developer Tools**:
- Open DevTools: `Cmd+Shift+I` (macOS) or `Ctrl+Shift+I` (Windows)
- Console Toggle: Built into app UI (console icon)
- View Rust logs: Check terminal output

### Audio Pipeline Debugging

**Key Metrics** (emitted by pipeline):
- Buffer sizes (mic/system)
- Mixing window count
- VAD detection rate
- Dropped chunk warnings

**Monitor via Developer Console**: The app includes real-time metrics display when recording.

## Platform-Specific Notes

### macOS
- **Audio Capture**: Uses ScreenCaptureKit for system audio (macOS 13+)
- **GPU**: Metal + CoreML automatically enabled
- **Permissions**: Requires microphone + screen recording permissions
- **System Audio**: Requires virtual audio device (BlackHole) for system capture

### Windows
- **Audio Capture**: Uses WASAPI (Windows Audio Session API)
- **GPU**: CUDA (NVIDIA) or Vulkan (AMD/Intel) via Cargo features
- **Build Tools**: Requires Visual Studio Build Tools with C++ workload
- **System Audio**: Uses WASAPI loopback for system capture

### Linux
- **Audio Capture**: ALSA/PulseAudio
- **GPU**: CUDA (NVIDIA) or Vulkan via Cargo features
- **Dependencies**: Requires cmake, llvm, libomp

## Performance Optimization Guidelines

### Audio Processing
- Use `perf_debug!()` / `perf_trace!()` for hot-path logging (zero cost in release)
- Batch audio metrics using `AudioMetricsBatcher` (pipeline.rs)
- Pre-allocate buffers with `AudioBufferPool` (buffer_pool.rs)
- VAD filtering reduces Whisper load by ~70% (only processes speech)

### Whisper Transcription
- **Model Selection**: Balance accuracy vs speed
  - Development: `base` or `small` (fast iteration)
  - Production: `medium` or `large-v3` (best quality)
- **GPU Acceleration**: 5-10x faster than CPU
- **Parallel Processing**: Available in `whisper_engine/parallel_processor.rs` for batch workloads

### Frontend Performance
- React state updates batched via Sidebar context
- Transcript rendering virtualized for large meetings
- Audio level monitoring throttled to 60fps

## Important Constraints and Gotchas

1. **Audio Chunk Size**: Pipeline expects consistent 48kHz sample rate. Resampling happens at capture time.

2. **Platform Audio Quirks**:
   - macOS: ScreenCaptureKit requires macOS 13+, needs screen recording permission
   - Windows: WASAPI exclusive mode can conflict with other apps
   - System audio requires virtual device (BlackHole on macOS, WASAPI loopback on Windows)

3. **Whisper Model Loading**: Models are loaded once and cached. Changing models requires app restart or manual unload/reload.

4. **No Separate Backend Dependency**: Meeting persistence, transcription, and LLM features are handled by the Tauri app. Do not reintroduce the archived FastAPI backend as a supported requirement.

5. **Legacy FastAPI Security Context**: The archived FastAPI/CORS behavior is unsupported legacy code and must not be treated as a supported production API.

6. **File Paths**: Use Tauri's path APIs (`downloadDir`, etc.) for cross-platform compatibility. Never hardcode paths.

7. **Audio Permissions**: Request permissions early. macOS requires both microphone AND screen recording for system audio.

8. **Rebrand migration**: The app was renamed Meetily → Riff and its bundle identifier changed `com.meetily.ai` → `com.rifaz.riff`. `brand_migration.rs` renames the old data, WebKit and config directories to the new names at startup, before the Tauri builder runs. Keep `IDENTIFIER` there in sync with `tauri.conf.json`. The browser-storage keys (`MeetilyRecoveryDB`, `meetily.*`, `meetily_user_id`) and legacy-import paths (`/usr/local/var/meetily`) keep their old names on purpose. `RIFF_*` env vars fall back to `MEETILY_*`.

9. **Updates and analytics are off**: the inherited updater feed and PostHog key belonged to upstream Meetily. `UPDATES_ENABLED` in `frontend/src/services/updateService.ts` says what to set to turn updates back on. Analytics is available only when the build is given `RIFF_POSTHOG_API_KEY`; otherwise nothing is sent and the consent toggle is hidden.

## Repository-Specific Conventions

- **Logging Format**: Rust logs should include enough module context to diagnose app behavior
- **Error Handling**: Rust uses `anyhow::Result`, frontend uses try-catch with user-friendly messages
- **Naming**: Audio devices use "microphone" and "system" consistently (not "input"/"output")
- **Git Branches**:
  - `main`: Stable releases
  - `fix/*`: Bug fixes
  - `enhance/*`: Feature enhancements
  - Current: `fix/audio-mixing` (working on audio pipeline improvements)

## Dev Sessions (meeting → requirements → plan → code → QA)

Merged in from the former standalone "harness" project (`~/harness_old`, gitlab `rifaz/harness`). Its backend lives on as `harness-server/` (see `harness-server/CLAUDE.md` for the agent design history — still accurate for everything under `backend/src`); its old Vite/React UI was rebuilt inside this Next.js app and is gone.

- **Process**: `frontend/src-tauri/src/agent_server.rs` starts `node --import tsx src/server.ts` in `harness-server/backend` at app setup and stops it on `RunEvent::Exit`: SIGTERM to its process group (so llama-helper, agent CLIs and QA dev servers go too), 5s grace, then SIGKILL. Its stdin is a pipe from the app and the server exits when it closes (`HARNESS_EXIT_ON_STDIN_CLOSE`), so a crashed or killed app can't orphan it. SIGINT/SIGTERM to the app (Ctrl+C in `tauri dev`) exits through `RunEvent::Exit`, and each exit cleanup step is time-limited: a hung exit would keep a windowless Riff holding the single-instance lock. Needs Node ≥22 (probes `RIFF_NODE`, Homebrew, nvm, then PATH — the default `node` on PATH may be too old). Runs `npm install` in `harness-server` first if `node_modules/tsx` is missing. Reuses anything already listening on the port (4319, `HARNESS_PORT`), so `npm run dev` in `harness-server` works for backend work. Log: `harness-server/state/agent-server.log`. Tauri commands: `get_agent_server_status`, `restart_agent_server`; event `agent-server-status`.
- **Server dir resolution**: `RIFF_HARNESS_SERVER_DIR`, else the source checkout the binary was built from (`CARGO_MANIFEST_DIR/../../harness-server`), else a `harness-server` resource dir. It is **not bundled** into release installers yet — a build only works on a machine with this checkout.
- **Security**: the server only accepts browser requests from the app's own origins (`config.allowedOrigins`, override with `HARNESS_ALLOWED_ORIGINS`) and rejects any other `Origin` with 403, since its agents can write code and run commands. The CSP `connect-src` allows `http://127.0.0.1:4319`.
- **UI**: `frontend/src/app/dev-sessions/**` (list, `session?id=&stage=`, `apps`, `apps/integrations?appId=`, `apps/api-spec?appId=`), components in `frontend/src/components/DevSessions/`, data layer in `frontend/src/lib/dev-sessions/` (React Query; `api.ts` holds the server URL, `NEXT_PUBLIC_AGENT_SERVER_URL` overrides). Provider keys / per-agent models / token usage (`TokenUsagePanel`, from `GET /api/usage`) / Jira live in Settings → Dev Agents.
- **Model routing**: plan steps tagged `effort: light` run their automatic coding turns on a cheaper model (Settings → Dev Agents → "Cheaper model for light steps"), escalating to the coding model if the step isn't finished. See `harness-server/backend/src/agents/model-routing.ts`.
- **Context resets**: the coding agent starts a new conversation per plan step, per QA fix and past 90k tokens; long turns (and team workstreams) compact at 110k. Each new conversation opens with a handoff from `harness-server/backend/src/agents/handoff.ts`: repo state plus notes the local Qwen writes about the previous conversation. See harness-server/CLAUDE.md step 20.
- **Local model**: the coordinator's continue/ready decisions run on Riff's built-in Qwen (`harness-server/backend/src/agents/local-llm.ts` drives `llama-helper` directly), falling back to the configured coordinator model. The agent roles need tool calling and stay on their configured models.
- **App themes**: an app's theme is defined in one file in its repo, `theme/theme.json`. `theme/{tokens,components,index}.css` and `docs/theme.md` are generated from it, and agents are told to build every view from its tokens and `ui-*` components, so swapping a theme is a one-file change. Server: `harness-server/backend/src/themes/` — `presets.ts` (starting-point themes), `theme-schema.ts` (zod validation; strings go into CSS, so no `;{}`), `theme-css.ts` (renders tokens + component CSS, and `tokenMaps` for previews), `apply-theme.ts` (save/regenerate/read; commits on the base branch only, refuses over a `theme/` it didn't generate; `inSync` detects a hand-edited theme.json). Routes in `routes/themes.ts`. Plan/coding/QA agents get a role-specific theme briefing (`theme-context.ts`, re-sent when the theme changes mid-session) and a read-only `audit_theme` tool (`theme-audit.ts`) for building on the theme and migrating existing styling onto it. Agent write tools refuse Riff-generated theme files. The requirements agent's `propose_theme` tool stores `session.themeProposal`; the Requirements tab opens the picker for the human to apply (`/theme-proposal/apply`) or dismiss. UI: `dev-sessions/apps/theme?appId=`, `components/DevSessions/themes/` (`ThemeStudio` = presets + editor + live preview, reused on the Theme page, Add-app form and `ThemeProposalPanel`). Previews get tokens inline from the server, so they match the generated CSS exactly.
- **Reference docs**: chat attachments are saved per session, and docs added on the Apps page are saved per app. Every agent reads them through `search_docs`/`read_doc` (`reference/…` paths) instead of asking again. See `harness-server/backend/src/sessions/reference-docs.ts` and harness-server/CLAUDE.md step 19.
- **Meeting → requirements**: one button in the meeting header and the journal header (`DevSessions/RequirementsButton.tsx`, shared by both; shows the latest session's stage and opens a dialog to continue one or start another) fetches the full transcript (+ optional AI summary) and POSTs it as `source` to `/api/sessions`. The server writes it to `harness-server/state/meeting-sources/<sessionId>.md` (gitignored — meeting content stays private), sets `sourceMeeting` + one-shot `meetingKickoffPending`, and attaches the file to whichever requirements message comes first. `GET /api/sessions?meetingId=` lists a meeting's sessions.

## Search (one engine for every search)

All search goes through the `riff-search` crate (`search/`, a workspace member): the meetings list (titles, transcripts, summaries), the journal shelf (journals and notes) and the Dev Sessions agents' `search_docs` (repo docs + reference docs). Journal **Ask** is separate: it gathers its own candidate passages for the summary model.

- **Engine** (`search/src`): callers hand over `Document`s made of `Segment`s (transcript lines, paragraphs, doc sections); `chunk.rs` groups them into ~900-character chunks that never span two headings (transcript chunks overlap by one line). `store.rs` keeps one SQLite file per process: `docs`, `chunks` (with an int8 embedding) and an FTS5 table (`porter unicode61`, BM25 weighted title 4 > heading 2 > body 1). A query runs keyword search (every term, then any term; terms are always quoted, so FTS5 syntax in the input is inert; the last word is a prefix while typing) and, when a model is loaded, brute-force cosine over the scope's vectors, then fuses both rankings by reciprocal rank (k=60) and optionally groups chunks per `group`. Snippets mark matches with `\u0002`/`\u0003`.
- **Meaning-only matches**: e5 similarities sit in a narrow band (unrelated text scores ~0.85), so no fixed cut-off works. A semantic hit with no keyword match is shown only if it stands out from the query's own scores across the scope by more than the expected maximum of N unrelated scores (`standout_test`, ~1.9σ at 32 chunks, ~3.1σ at 1k). Below that, semantic rank still reorders keyword hits.
- **Model**: `multilingual-e5-small` int8 ONNX (118 MB + 17 MB tokenizer, pinned revision + SHA-256, `embed.rs` `DEFAULT_MODEL`), run with `ort` like Parakeet, mean-pooled, `query:`/`passage:` prefixes. Stored in `<app data>/models/embeddings/multilingual-e5-small/`. Downloaded automatically at startup unless the user removed it in Settings → Search (remembered in the index's meta). Embeddings are keyed by the model id, so changing `DEFAULT_MODEL` re-embeds everything. Chunks embed `title\nheading\ntext`, and unchanged chunks keep their vectors on re-index.
- **Writes are serialised** (`Index::writing`): deferred SQLite transactions that read then write fail at once with SQLITE_BUSY under WAL when another connection is writing.
- **App** (`frontend/src-tauri/src/search/`): `search.sqlite` in the app data dir, scope `riff`, kinds `transcript`/`summary` (group = meeting id) and `journal`/`journal_note` (group = notebook id). `sources.rs` reconciles it from the meetings DB by fingerprint (transcripts: title + row count + max rowid; summaries: title + `updated_at`; journals: content hash; notes: journal + title + length), so no write path needs a hook. A worker (`mod.rs`) syncs every minute and on `wake`, embeds pending chunks 64 at a time and pauses while recording; the `search` command syncs (throttled to 2 s) before searching. Commands: `search`, `search_status`, `search_download_model`, `search_remove_model`, `search_rebuild_index`; events `search-status`, `search-model-progress`. The index is derived data: deleting `search.sqlite` rebuilds it.
- **Agent server**: harness-server runs the same engine as a child process (`riff --search-stdio`, JSON lines; `search/src/stdio.rs`). `agent_server.rs` passes `RIFF_SEARCH_BIN` (the app's own binary) and `RIFF_EMBEDDING_MODELS_DIR`; without the app it falls back to `target/{release,debug}/riff-search` or `riff`. See harness-server/CLAUDE.md step 24.
- **UI**: `frontend/src/lib/search/api.ts` (`useSearch`, debounced, grouped; `useSearchStatus`), `components/Search/SearchHitText.tsx` (highlighted snippet, "Transcript · 12:04" location, "related" for meaning-only matches), `components/SearchSettings.tsx` (Settings → Search).
- **Tests**: `cargo test -p riff-search`; with the model, `RIFF_SEARCH_MODEL_DIR=<dir> cargo test -p riff-search --test semantic`; `cargo test -p riff --lib search::`.

## Journals (recording → summary → journals)

Every meeting flows recording → AI summary → journals. Auto-summary is on by default (`isAutoSummary` in `ConfigContext`, triggered on the meeting page for `source=recording|import`). When a meeting is saved (`api_save_transcript`, audio import), `journal::service::spawn_after_summary` waits for its summary (up to 60s for it to start, 20 min to finish, else files from the transcript), then splits the meeting into topic **parts** and files each into a **journal** (a durable topic; internally `notebooks` / `notebook_entries`). Journal overviews are recompiled after each filing.

- **Rust**: `frontend/src-tauri/src/journal/` — `repository.rs` (tables `notebooks`, `notebook_entries`, `journal_meeting_status`; migrations `20260930000000_add_journal.sql`, `20261001000000_journal_review.sql`), `llm.rs` (the user's summary provider/model via `summary::llm_client::generate_summary`), `service.rs`, `commands.rs` (`journal_*`).
- **Filing**: the transcript is chunked to the model's budget; each prompt carries the journal list (with recent note titles) and the meeting summary. The model returns parts with a journal, a 0–1 confidence, alternatives and a question. Parts below `CONFIDENCE_THRESHOLD` (0.6) are stored `status = 'needs_review'` with `notebook_id` NULL and `suggestions` JSON, and the meeting's status becomes `needs_review`; the user answers via `journal_move_entry` (existing journal or `new_title`). Proposed journals are only created for confidently filed parts. Entries are written only after every model call succeeds. Jobs are serialized (`ORGANIZE_LOCK`) and de-duplicated (`ACTIVE`); stored in-flight rows not in `ACTIVE` report as `unfiled`. Progress is the `journal-updated` event.
- **Journal → Dev Session**: compiling an overview also asks the model whether the journal is about software (`notebooks.is_software`; older journals are classified when first opened). Every journal shows the shared `RequirementsButton` with `kind: 'journal'` (`is_software` only drives the cover badge): `journal_requirements_brief` builds the notes + transcript excerpts, posted as a `source` with `kind: "journal"` (`meetingId` = journal id), and `meetingKickoffMessage` sends a journal-specific kickoff.
- **Pruning**: journals with `auto_created = 1` are deleted when they lose their last entry. Creating/editing a journal in the UI clears the flag.
- **Ask**: no embeddings. Candidates are filed notes plus transcript passages around each note's time range, keyword/IDF-ranked when over budget; the model cites `[n]` and only cited sources are returned (meeting date, estimated wall-clock start = save time − recording length, offset).
- **UI**: `frontend/src/app/journal/` (shelf with "Needs your input", `notebook?id=`), `components/Journal/` (`ReviewCard`/`ReviewInbox` answer the organizer's questions), `components/MeetingDetails/MeetingJournalStrip.tsx` (where a meeting's parts went, inline review), sidebar journal dots + review badge, `lib/journal/` (React Query; `JournalEventsBridge` in the root layout).

## Key Files Reference

**Core Coordination**:
- [frontend/src-tauri/src/lib.rs](frontend/src-tauri/src/lib.rs) - Main Tauri entry point, command registration
- [frontend/src-tauri/src/audio/mod.rs](frontend/src-tauri/src/audio/mod.rs) - Audio module exports
- [frontend/src-tauri/src/database/mod.rs](frontend/src-tauri/src/database/mod.rs) - Local database module

**Audio System**:
- [frontend/src-tauri/src/audio/recording_manager.rs](frontend/src-tauri/src/audio/recording_manager.rs) - Recording orchestration
- [frontend/src-tauri/src/audio/pipeline.rs](frontend/src-tauri/src/audio/pipeline.rs) - Audio mixing and VAD
- [frontend/src-tauri/src/audio/recording_saver.rs](frontend/src-tauri/src/audio/recording_saver.rs) - Audio file writing

**UI Components**:
- [frontend/src/app/page.tsx](frontend/src/app/page.tsx) - Main recording interface
- [frontend/src/components/Sidebar/SidebarProvider.tsx](frontend/src/components/Sidebar/SidebarProvider.tsx) - Global state management

**Search**:
- [search/src/store.rs](search/src/store.rs) - Index: schema, sync, hybrid search, embedding
- [frontend/src-tauri/src/search/sources.rs](frontend/src-tauri/src/search/sources.rs) - What the app indexes and how changes are detected

**Whisper Integration**:
- [frontend/src-tauri/src/whisper_engine/whisper_engine.rs](frontend/src-tauri/src/whisper_engine/whisper_engine.rs) - Whisper model management and transcription
