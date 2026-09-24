# Dev Sessions agent server

The local server behind Riff's **Dev Sessions**: four agent roles —
**requirements**, **plan**, **coding** and **QA** — that take a feature from
a meeting transcript (or a typed idea) to a reviewed branch on one of your
configured apps (a repo checkout), grounded in that repo's `docs/*.md`.
Every stage has an explicit human approval gate; no agent can push, merge,
open an MR, or approve its own work.

This used to be a standalone project with its own web UI ("harness"). The UI
now lives inside the Riff desktop app; this directory is just the server.

## Running it

You normally don't: the Riff desktop app starts it in the background
(`frontend/src-tauri/src/agent_server.rs`) and stops it when the app quits.
It needs **Node 22+** — the app looks for it in `RIFF_NODE`, Homebrew
(`/opt/homebrew/opt/node/bin/node`), nvm, then `PATH`, and runs
`npm install` here the first time if dependencies are missing. If the Dev
Sessions pages say the agent server isn't running, the banner shows why and
has a Restart button; the full log is `state/agent-server.log`.

For backend development, run it yourself with file watching — the app will
use an already-running instance instead of starting its own:

```bash
npm start          # install (idempotent) + tsx watch on http://127.0.0.1:4319
npm run typecheck
```

## Configuration

Everything is configured from the app, not by editing files:

- **Settings → Dev Agents**: provider credentials (your Claude subscription
  via `claude login`, or an Anthropic / OpenAI / Google API key), the
  provider and model for each agent, and optional Jira. Stored in
  `backend/local-settings.json` (gitignored, never sent back to the UI).
- **Dev Sessions → Apps**: target repositories, per-app check commands and
  per-app agent prompt overrides (`backend/local-apps.json`,
  `backend/local-prompts.json`, both gitignored).

Environment (optional, `backend/.env`): `HARNESS_PORT` (default 4319) and
`HARNESS_ALLOWED_ORIGINS` — the browser origins allowed to call the server.
The defaults cover the Riff webview and its dev server; any other
`Origin` is rejected with 403, because the agents can write code and run
commands.

## How a session flows

1. **Requirements** — start from a meeting (transcript toolbar →
   *Requirements*) or from Dev Sessions → *New session*. For a meeting, the
   transcript (and optionally Riff's AI summary) is saved under
   `state/meeting-sources/` and attached to the first agent turn
   automatically. The agent asks clarifying questions and writes
   `artifacts/requirements/<key>.md`. Approve to continue.
2. **Plan** — a step-by-step plan in `artifacts/plans/<key>.md`; optionally
   one Jira ticket per step. Approve to continue.
3. **Coding** — works on its own branch in the app's repo and commits; you
   review the diff in the app. Approving doesn't push or merge anything.
4. **QA** — reviews the diff against the acceptance criteria, runs the repo's
   lint/test scripts, writes `artifacts/qa-reports/<key>.md`.

`state/` (sessions, meeting transcripts, log) is gitignored and disposable;
`artifacts/` is not — whether to commit those docs is your call.

See `CLAUDE.md` in this directory for the agent/tool design and its history.
