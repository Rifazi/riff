import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(import.meta.dirname, '../.env') });

// This harness is a standalone project that operates on separate checkouts
// of one or more target repos ("apps" — see apps/apps-store.ts), pointed at
// per-app instead of a single TARGET_REPO_ROOT env var (see CLAUDE.md's
// "Origin and evolution" for why that changed).
const HARNESS_ROOT = path.resolve(import.meta.dirname, '../..');

export const config = {
  // This project's own root and runtime state — never inside any target
  // repo.
  harnessRoot: HARNESS_ROOT,
  stateDir: path.join(HARNESS_ROOT, 'state'),
  sessionsStateDir: path.join(HARNESS_ROOT, 'state', 'sessions'),
  meetingSourcesDir: path.join(HARNESS_ROOT, 'state', 'meeting-sources'),
  // Requirements/plan/QA docs — reviewable deliverables of *this* project's
  // process, not of any target app, so they live here rather than in a
  // target repo. Global across apps: sessionKey is already required to be
  // globally unique (see routes/sessions.ts), so these don't need to be
  // namespaced per app. Not gitignored (unlike state/): whether to commit
  // them in this project's own history is the user's call, not assumed
  // either way.
  requirementsDir: path.join(HARNESS_ROOT, 'artifacts', 'requirements'),
  plansDir: path.join(HARNESS_ROOT, 'artifacts', 'plans'),
  qaReportsDir: path.join(HARNESS_ROOT, 'artifacts', 'qa-reports'),

  port: Number(process.env.HARNESS_PORT ?? 4319),

  // Browser origins allowed to call this server. The agents can write code
  // and run commands, so this must not be open to arbitrary websites.
  // Defaults cover the Meetily desktop webview (macOS/Linux and Windows
  // schemes) and its Next.js dev server.
  allowedOrigins: (
    process.env.HARNESS_ALLOWED_ORIGINS ??
    'tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:3118,http://127.0.0.1:3118'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};
