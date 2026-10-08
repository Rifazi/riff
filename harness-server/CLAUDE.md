# Customer-EDI AI harness — project context

Read this before doing any work here. It's written for picking the project
back up cold, not as user-facing docs (see `README.md` for that).

## What this is

A standalone local dev tool: a web UI backed by separate agent roles —
**requirements**, **plan**, **coding**, **QA** — that take a feature through
the full lifecycle on one of this harness's configured **apps** (a repo
checkout registered via the Apps page — [Customer-EDI](../Customer-EDI) was
the original and remains the default/legacy one, but the harness is no
longer hardcoded to it; see step 7 below), grounded in that repo's
`docs/*.md`. Every stage has an explicit human approval gate
(Approve/Reject); no agent can push, merge, open an MR, or approve its own
work.

It lives here, next to Customer-EDI, not inside it — originally it was
built as a `harness/` subfolder of Customer-EDI itself, then moved out to
its own project (this one) when the user wanted it treated as a separate
codebase. Customer-EDI is touched **only** for actual functional changes —
the coding agent's adapters/schemas/CDK/docs edits, on its own branch.
Requirements/plan/QA docs are process artifacts of this project, not of
Customer-EDI, and live entirely here, under `artifacts/` (see step 6
below) — never inside the target repo.

## Origin and evolution (read this to avoid re-litigating settled decisions)

1. Built inside Customer-EDI on the **Claude Agent SDK** (Anthropic-only,
   spawns a Claude Code CLI subprocess, tools exposed via an in-process MCP
   server, `tools: []` to disable built-ins as the security boundary).
2. User asked for one-click launch → added `npm start` chaining
   install+dev, `postinstall` auto-creates `.env`, Vite `open: true`.
   Discovered `engine-strict` inherited from Customer-EDI's own `.npmrc`
   when invoked via `npm --prefix` — fixed by switching the cross-project
   launch script to `cd ... && npm run start` instead, which fully isolates
   npm config. Also dropped an unnecessary `engines: "20.x || 22.x"` field
   that was blindly copied from Customer-EDI (which pins it for AWS Lambda
   runtimes — irrelevant here).
3. User asked to move it to its own project → moved `backend/`,
   `frontend/`, `scripts/`, root files here; `requirements/`/`qa-reports/`
   stayed in Customer-EDI. `config.ts` changed from computing the target
   repo path via a fixed relative offset (`../../..` from its own source,
   which only worked when nested) to reading `TARGET_REPO_ROOT` from
   `backend/.env`, validated the same way (checks for `package.json` +
   `docs/`). `ensure-env.js` auto-detects a sibling `Customer-EDI` folder.
4. User asked for any-provider support with a login/configure workflow →
   **this was a full agent-engine rewrite**, not an add-on. The Claude
   Agent SDK only talks to Anthropic; swapped it for the **Vercel AI SDK**
   (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@ai-sdk/google`), which
   has a genuinely provider-agnostic `streamText`/`tool()` interface. Added
   a Settings page (API key entry with live Test, per-role provider+model
   picker) backed by `backend/local-settings.json` (gitignored, server-side
   only, never sent to the browser). Conversation continuity changed from
   an opaque Anthropic-specific "SDK session ID" to storing the actual
   `ModelMessage[]` history per stage in the session record — provider-
   agnostic, and lets different roles use different providers in the same
   session. All 8 tool definitions were converted from the old
   `tool(name, desc, schema, handler) => {content, isError}` shape to the
   AI SDK's `tool({description, inputSchema, execute})` shape, where
   `execute` either returns a plain value or **throws** (thrown errors
   auto-become a `tool-error` part the model sees) — see "Tool error
   convention" below for which failure modes use which.
5. User asked "can you add Claude as a provider" — meaning a genuine
   subscription/OAuth login (`claude login`, billed against Pro/Max usage),
   not just relabeling the existing Anthropic API-key option (confirmed via
   AskUserQuestion before building — the two are very different scopes).
   Only the Claude Agent SDK can do that kind of login, so this **brought
   the Claude Agent SDK back** as a second engine running alongside the
   Vercel AI SDK one from step 4, rather than replacing it. To avoid every
   tool existing twice, each `tool-defs/*.ts` file was split into a shared
   core (schema + description + plain `execute` function, still exported
   for the AI-SDK `tool()` wrapper already there) and a new sibling file
   under `tool-defs-claude/` that wraps the *same* execute function for the
   Claude Agent SDK's `tool()` format via `tool-defs-claude/wrap.ts`
   (`wrapForClaudeSdk`, converting return-or-throw into
   `{content, isError}`). `Provider` gained a `'claude'` member;
   `ApiKeyProvider = Exclude<Provider, 'claude'>` types the three that still
   need a stored key. `SessionRecord` gained `claudeSessionIds` (parallel to
   `histories`, used only by whichever stage actually ran on the "claude"
   provider — that engine resumes its own server-side session by ID rather
   than replaying a message array). Each of the three `*-agent.ts` files now
   branches on `provider === 'claude'` early and picks the whole tool
   set/engine accordingly; the shared tail (transcript persistence,
   requirements/QA-report path detection) is unchanged. New default:
   fresh installs default every role to `claude` (zero-config if you're
   already logged in), not `anthropic`.
6. User asked for requirements/plan/QA docs to move out of Customer-EDI
   entirely, into this project — **supersedes step 3's design** (and the
   original spec), which had `harness/requirements/` and
   `harness/qa-reports/` as committed deliverables of the target repo.
   Motivation: Customer-EDI should be touched only for actual functional
   changes, never for the harness's own process artifacts. Also added a
   **plan stage** (Requirements → Plan → Coding → QA, one more human
   approval gate — a `write_plan_doc` tool produces a reviewable
   step-by-step breakdown of an approved requirements doc, which then seeds
   the coding agent's own step checklist instead of it inventing one), and
   an opt-in per-session **coordinator** (`session.coordinatorEnabled`,
   `agents/coordinator-agent.ts`) — a tool-less decision-maker that
   auto-drives a stage's conversation forward and hands off to the next
   stage after a human approval, but never approves/rejects anything
   itself. `config.ts`'s `requirementsDir`/`plansDir`/`qaReportsDir` now
   point at `<harnessRoot>/artifacts/*` instead of
   `<repoRoot>/harness/*`; `session.requirementsPath`/`planPath`/
   `qaReportPath` are now **harnessRoot-relative**, not repoRoot-relative —
   every read site does `path.join(config.harnessRoot, session.XPath)`, not
   `config.repoRoot`. This also **fully removed** the git auto-commit
   machinery (`commitPathIfDirty`, `createBranch`'s retry loop) that step
   3's design had needed: since these docs no longer live in Customer-EDI's
   working tree at all, there's nothing to auto-commit before
   `git_create_branch` — the class of "uncommitted harness doc blocks
   branch creation" bugs that motivated that machinery is gone by
   construction, not papered over. `artifacts/` is deliberately **not**
   gitignored (unlike `state/`) — whether to commit these in this
   project's own git history is the user's call.

7. User asked for multi-app support — pick which target repo a session
   drives from the UI, plus per-app-per-role prompt overrides instead of
   the checked-in prompts being hardcoded to Customer-EDI. This touched the
   same `config.repoRoot`/`docsDir`/`repoUrl` singleton step 3 already
   restructured once, so it's the largest single mechanical change since
   the step-4 engine rewrite, even though it's additive rather than a
   replacement. `config.ts` **lost** `repoRoot`/`docsDir`/`repoUrl`/
   `resolveTargetRepoRoot` entirely — those are now per-app, resolved via
   the new `apps/apps-store.ts` (`AppConfig { id, name, repoRoot }`,
   persisted to `backend/local-apps.json`, same runtime-editable-JSON
   treatment as `local-settings.json`). Every module that used to import
   the global `config.repoRoot`/`docsDir` directly (`repo/guardrails.ts`,
   `repo/git.ts`, `repo/docs-index.ts`, `repo/integrations.ts`, the
   repo-touching `tool-defs/*.ts`, `sdk-client.ts`'s Claude subprocess
   `cwd`) now takes `repoRoot` (or a whole `AppConfig`) as a parameter
   instead; `docs-index.ts` in particular went from one module-level
   `sections`/`indexedAt` pair to a `Map<appId, ...>` so search_docs never
   mixes two apps' docs. Each `*-agent.ts` resolves `getApp(session.appId)`
   once per turn and threads it through everywhere it used to reach for
   `config` — see any of the four for the shape, they're identical.
   `requirementsDir`/`plansDir`/`qaReportsDir` under `artifacts/`
   deliberately **stayed global**, not per-app: `sessionKey` was already
   required to be globally unique (`routes/sessions.ts`'s collision check
   predates this feature), so nothing needed moving there, and doing so
   would have meant migrating real files. `SessionRecord` gained `appId`;
   `session-store.ts`'s `normalizeSession` defaults a missing one (every
   session that existed before this feature) to a fixed legacy app id
   (`customer-edi`), which `apps-store.ts` auto-seeds from the old
   `TARGET_REPO_ROOT` env var the first time it's read if
   `local-apps.json` doesn't exist yet — so upgrading needs no manual
   migration step. The four `backend/src/agents/prompts/*.md` files, which
   used to hardcode Customer-EDI's own conventions (hexagonal Lambda/CDK,
   named trading partners, its bucket-reuse policy, its "Adding a flow"
   recipe) directly in what should be role-generic instructions, were
   rewritten to be app-agnostic; the original Customer-EDI-specific text
   was preserved verbatim under
   `backend/src/agents/prompts/customer-edi-legacy/` and is auto-seeded as
   the `customer-edi` app's own prompt **override** the first time
   `backend/local-prompts.json` is read (see `settings/prompts-store.ts`)
   — so the existing Customer-EDI workflow behaves identically after
   upgrading, it's just no longer baked into the shared base prompt. An
   override fully **replaces** its role's base prompt for that app (not an
   append) — simpler mental model for "this app's coding agent should
   follow these conventions instead," and the Apps page shows the base
   prompt read-only alongside the override textarea so it's clear what's
   being replaced. `coordinator-agent.ts`'s `DECISION_INSTRUCTIONS` is
   also override-able the same way even though it has no prompt *file*
   (its base is the inline constant, exported for `agents/prompts.ts`'s
   `readBasePrompt()` to expose it as if it were one). The old global
   `/api/health` (`repoRoot`/`repoUrl`) and `/api/integrations`,
   `/api/docs/handbook`, `/api/docs/openapi.json` routes are gone,
   replaced by `routes/apps.ts`'s `/api/apps/:id/...` equivalents; the
   Integrations and API Spec pages moved from global nav links to
   per-app pages linked off the Apps page instead of gaining a "current
   app" selector, since neither one otherwise needed one.

8. Merged into Meetily (the desktop meeting recorder/transcriber, since
   rebranded Riff) as its
   "Dev Sessions" feature: this directory moved to
   `<riff>/harness-server/`, the Vite `frontend/` was **deleted** and its
   pages rebuilt in Riff's Next.js/Tailwind UI
   (`frontend/src/app/dev-sessions/**`, `frontend/src/components/DevSessions/`),
   and Riff's Tauri core starts/stops this server
   (`frontend/src-tauri/src/agent_server.rs`, `node --import tsx` so it's one
   killable process). New: a session can be created from a meeting —
   `POST /api/sessions` takes an optional `source` (transcript + optional AI
   summary), written to `state/meeting-sources/<sessionId>.md` (state/, not
   artifacts/: meeting content is private) and attached server-side to the
   first requirements message via the one-shot `meetingKickoffPending` flag
   (same clear-on-next-message rule as `requirementsRelayPending`). The
   kickoff *instructions* travel in that first message rather than the base
   prompt, because an app's prompt override replaces the base prompt
   wholesale. CORS went from `origin: true` to an allowlist plus an
   `onRequest` 403 for unknown `Origin`s — now that the server runs whenever
   Riff does, any website could otherwise have driven the agents.
   The frontend-specific notes below (pages/, lib/, components/) describe
   the old Vite UI; the Riff ports keep the same logic and names.

9. User asked for the app to break a too-big feature into separate
   requirements. The requirements agent got a `propose_split` tool
   (`tool-defs/propose-split-tool.ts`): 2-8 parts in build order, each with
   a self-contained brief and `dependsOn` (earlier indexes only). It only
   records `session.splitProposal`; the human-only
   `/requirements/split/accept` creates one child session per part (key
   `<parentKey>-<slug>`, own copy of the meeting transcript, `splitFrom`
   with resolved sibling dependencies, one-shot `splitKickoffPending` that
   attaches the brief to the child's first message) and moves the parent to
   the terminal `split` stage (`splitInto`, doc superseded).
   `/requirements/split/dismiss` or approving a doc clears the proposal. The
   when-to-split guidance lives mainly in the tool description, not just the
   base prompt, because a prompt override (e.g. customer-edi's) replaces the
   base prompt wholesale. Each child still branches off the app's base
   branch; step 33 made the order and dependencies count. Live-verified on a scratch server:
   propose (incl. the ordering check), accept, dismiss, and the guards
   against a second accept and messages to a split parent. A real agent run
   of a child's kickoff has not been exercised.

10. User asked for planning to detect parallelizable coding and run a team
   of agents concurrently, with a UI that makes the team obvious.
   `write_plan_doc` takes optional `workstreams` (`sessions/plan-doc.ts`:
   steps grouped, each with `ownedPaths` and `dependsOn`), rejected unless
   every step is assigned once, owned paths are disjoint, deps are acyclic,
   and at least two workstreams can actually run at once. The plan doc's
   frontmatter carries them. With 2+ workstreams the Coding tab runs
   `agents/team/coding-team.ts` (`POST /coding/team/run`, SSE of
   `team_member_*` events) instead of the single agent. It creates the
   session branch, gives each member a git worktree under
   `state/worktrees/<sessionId>/<id>` on `<branch>--<id>` (branched off the
   session branch *after* its deps merged; `node_modules` symlinked in and
   excluded from catch-all adds), runs `team/workstream-agent.ts`, the normal
   coding prompt + `prompts/coding-team-member.md`, with every repo tool
   rooted at the worktree. `write_file`/`edit_file`/`run_prettier` enforce
   `ownedPaths` (`assertWritable`), which is what makes the merges
   conflict-free. `update_my_steps` replaces `write_coding_plan` because
   several members share `session.codingPlan` (`mutateSession` does the
   read-modify-write under the session lock). No `git_create_branch`, and
   `run_npm_install` only for the member owning `package.json`. Each member
   implements its whole workstream in one turn. When it finishes, leftovers
   are committed, and its branch is `--no-ff` merged into the session branch
   under a per-repo lock (`withRepoLock`); then its worktree and branch are
   removed. A failed or unmerged member leaves the team `needs_attention`
   and its dependents `blocked`. Calling the run again resumes every
   unmerged member, continuing its own history/claude session.
   `recoverInterruptedTeams()` at boot marks a run cut off by a restart
   `interrupted`. Afterwards `transcripts.coding` is the **lead's** chat
   (same coding agent, told the team already merged its work on the branch)
   for review follow-ups and QA fixes. The coordinator never drives the
   team. The frontend shows the lineup on the Plan tab and a team board on
   the Coding tab (`components/DevSessions/CodingTeam.tsx`, personas in
   `lib/dev-sessions/agents.ts`, `useTeamRun`), with lead chat behind a
   toggle.

11. User asked for cheaper models on lower-effort work, automatically.
   `write_plan_doc` steps take an optional `effort` (`light` | `standard`,
   default standard); the plan agent tags mechanical, fully-specified steps
   light. `agents/model-routing.ts` resolves the coding role's `lightModel`
   (unset = `DEFAULT_LIGHT_MODEL` for the provider, `''` = off). Only
   automatic step turns route: the Coding tab's kickoff/Continue/auto-run
   send `stepTurn: true`, and the coordinator's coding turns count as step
   turns. Human-typed follow-ups, QA fixes and reconciliation always use the
   coding model. The requirements, plan and QA roles are never routed; QA is
   the check on light work. If the light turn errors or its step isn't
   `done` afterwards, the coding model resumes the same conversation in the
   same request with an escalation prompt. Claude sessions accept a
   different model on `resume`, and this was verified live. Team workstreams
   whose steps are all light start on the light model and escalate the same
   way; a resumed member always gets the full model.

12. User asked to use Riff's free local Qwen (the built-in summary model)
   wherever it can do the job. `agents/local-llm.ts` drives Riff's
   `llama-helper` binary directly: JSON lines over stdin/stdout, the Qwen
   3.5 non-thinking template, and the GGUF from Riff's
   `models/summary/` data dir (4B, else 2B). The process is kept warm and
   exits after 5 idle minutes or on stdin EOF. It has no tool calling, so it
   only fits single-shot calls. The coordinator's continue/ready decision
   is the only one of those; every agent role is a tool-calling loop and
   stays on its configured model. The coordinator tries local first
   (`models.coordinator.useLocalModel`, unset = on) and falls back to its
   configured model on any error or unparseable reply. On a 12-case
   decision set run 3 times, Qwen 4B scored 34/36 and Haiku 11/12, but
   only after two changes that fixed failures seen first on Qwen:
   `DECISION_INSTRUCTIONS` now says "ready" whenever the agent is waiting
   on the human, and `hasUnansweredQuestion` also treats a `?` in the
   agent's closing paragraph as a pending question, so no model is asked.
   Without them, Qwen answered the agent's questions on the human's behalf.
   Every remaining miss stopped early, which is the safe direction.

13. User asked for default themes for new and existing apps, with theming
   code that's consistent and reusable across pages, and a visual picker.
   `themes/presets.ts` holds six presets (light + dark colors, fonts,
   radius, border width, shadows, density) and is the only place theme
   values live. `themes/theme-css.ts` renders a preset two ways from the
   same rules: repo files (tokens on `:root`, dark via
   `prefers-color-scheme` unless `<html data-theme>` pins it, components
   in `@layer ui`) and the preview stylesheet (tokens scoped to
   `[data-ui-theme="<id>"]`, mode via `data-ui-mode`, component rules once).
   Components reference only tokens (hover/soft/focus are derived with
   `color-mix`, badge/alert tones via a local `--tone`), so there's one
   component stylesheet for every theme. `apply-theme.ts` writes `theme/`
   + `docs/theme.md` (indexed by search_docs) and commits just those paths
   on the base branch under `withRepoLock`. It refuses on another branch,
   so theme files never land in a feature branch, and over a `theme/` it
   didn't generate (marker: `generatedBy` in `theme/theme.json`). Which
   theme is applied is read from that manifest, like `readRepoUrl`, never
   stored. The theme rules travel as a prompt section appended after the
   prompt override (same reasoning as step 9: an override replaces the
   base prompt), on plan/coding/QA first turns and every team member.
   Verified on a scratch server copy + scratch repos: apply, idempotent
   re-apply (no commit), switch, create-with-theme, both refusals, and the
   generated CSS in a plain HTML page in light/dark/pinned modes. An agent
   actually building UI against a theme has not been exercised.

14. User asked to edit themes, to have the theme defined in one file in the
   target project that components and views reference (easy to swap),
   and to be able to ask the requirements tab for a change and get the
   theme picker. `theme/theme.json` became the app's **definition** (was a
   generated manifest): `{ about, generatedBy, basedOn, theme }`, where
   `theme` is a `ThemeDefinition` (presets are now only starting points,
   `ThemePreset = ThemeDefinition & { id }`). `saveAppTheme` validates any
   definition (`themes/theme-schema.ts`) and regenerates the CSS + docs
   from it. `readAppTheme` compares the generated files against a fresh
   render to report `inSync`, so a hand edit shows a "Regenerate CSS"
   button (`regenerateAppTheme`). The preview no longer ships per-preset
   scoped CSS: `/api/themes` returns preset token maps plus the component
   CSS once, `/api/themes/preview` renders token maps for unsaved edits,
   and `ThemeFrame` sets them as inline custom properties. The editor never
   re-implements the renderer. Requirements got `propose_theme`
   (`tool-defs/propose-theme-tool.ts`): a preset or the app's current theme
   plus partial `changes`, merged and validated, stored as
   `session.themeProposal`. Like a split, only the human applies it
   (`POST /api/sessions/:id/theme-proposal/apply`, optionally with an edited
   definition) or dismisses it, and the coordinator waits on it. The
   Requirements tab opens the picker dialog automatically when a proposal
   arrives, and after applying it sends a chat message so the agent knows.
   The when-to-use guidance is in the tool description plus a short
   first-turn system-prompt note, for the usual reason that overrides
   replace the base prompt. Live-verified on a scratch server copy: editing
   and saving on the Theme page, hand edit → out of sync → regenerate, CSS
   injection rejected, and a real requirements turn (claude provider) that
   called propose_theme, auto-opened the picker and applied/committed.

15. User asked for the coding agent to know the theme-picker flow, build
   apps on the theme, and migrate existing apps onto it. Theme context is
   now per role (`themes/theme-docs.ts` `themeBriefing(role, name)`: the
   shared rules, the fact that the picker belongs to Riff and not the app,
   and a plan/coding/QA-specific part with the migration order), delivered
   by `themes/theme-context.ts`. It goes in the system prompt on a stage's
   first turn and in the turn prompt whenever `theme.json`'s fingerprint
   differs from `session.themeContextSeen[role]`, so a resumed Claude
   session still hears about a theme applied mid-session. Team members
   always get it in their fresh system prompt. New read-only
   `audit_theme` tool (`themes/theme-audit.ts`, for requirements, plan,
   coding, team members and QA) scans all tracked and untracked
   non-ignored files, unlike `search_code`, which is hard-wired to
   src/ and infra/. It reports whether theme/index.css is imported, hard-coded color
   literals, app-defined CSS tokens, **collisions** (app tokens with a
   theme token's name: they override the theme by load order and can't be
   aliased, since `--x: var(--x)` is circular, so a migration deletes them),
   Tailwind configs and component libraries. The Theme page shows the same
   audit (`GET /api/apps/:id/theme/audit`, `ThemeAdoptionCard`) with a
   "Start migration session" button (a session plus `?kickoff=theme-migration`,
   sent once into an empty requirements chat). `assertWritable` now refuses
   writes (write_file, edit_file, run_prettier) to a Riff-generated
   `theme/` or `docs/theme.md`. The requirements agent treats migrating
   code onto the theme as a normal requirements doc, and theme
   picking/editing as picker-only. `inSync` now compares only the generated
   CSS, since `docs/theme.md` also changes when a Riff update rewords it.
   The theme's base `body` rule resets `margin`. Live-verified on a scratch
   server copy with a legacy app built to have colliding tokens, other
   tokens and hard-coded colors, given approved requirements and a
   high-level plan: the coding agent (claude provider) ran audit_theme,
   wired the theme in, deleted the collisions, aliased the rest, moved
   Button and markup onto ui-* classes, pinned dark, and re-audited to 0
   hard-coded colors, never touching theme/. The page rendered correctly
   before and after. Also verified: the write guard, a mid-session re-brief
   after a theme switch, and the adoption card → migration kickoff. The
   migration's plan and QA stages were not run by real agents.

16. User asked for the presets to use color theory and have fun, memorable
   names. They're now Blueberry Fizz (complementary), Grape Soda
   (split-complementary), Matcha Latte (analogous), Peach Cobbler
   (analogous plus one complementary accent), Midnight Arcade (triadic) and
   Zine Machine (achromatic with Bauhaus spot colors). They keep the
   old slots' shape, fonts and density. Each palette was built in OKLCH
   from its harmony's hues, and each color's lightness was then tuned
   until it passed WCAG AA where it's used, in both modes: text and muted
   text on bg/surface/surfaceMuted, onPrimary on primary, primary as link
   text on surfaces, and white on danger (the destructive button). That is
   why light-mode primaries are darker than dark-mode ones. The tuned hex
   values are committed in presets.ts; the throwaway generator isn't. The
   preset ids changed, so an app whose theme.json says `basedOn: "slate"`
   (etc.) keeps its theme but no longer matches a preset. It shows as its
   own "Current" theme, and saving writes `basedOn: null`.

17. User asked for the requirements agent to reach the web, but only when
   they specifically ask. `tool-defs/fetch-url-tool.ts` adds `fetch_url`
   (both engines; HTML stripped, 20k chars, text types only, loopback/private
   hosts refused on every redirect hop). It is always registered, so old
   calls in replayed AI-SDK history stay valid, but its execute refuses
   unless the turn enabled it. `routes/requirements.ts` enables it only when
   the human's typed message passes `wantsWebAccess`: an "online"/"search the
   web" phrase, or a URL plus a read verb. Attachments, meeting transcripts
   and coordinator turns never enable it. An enabled turn gets
   `WEB_ACCESS_TURN_NOTE` prepended to its prompt, not the system prompt,
   because of resume and because an app's prompt override replaces the base
   prompt. No web search tool: `fetch_url` only reads pages.

18. User asked for QA findings the coder should act on to reach it even when
   the branch technically passes. `write_qa_report` gained optional
   `actionableNotes` (frontmatter `actionable-notes`). The guidance lives in
   the schema description as well as the base prompt, because an app's
   prompt override replaces the base prompt. A `pass` with notes is stored
   as `pass-with-notes`, so the "Send back for fixes" button shows.
   `compactQaFindings`, and its client twin in `CodingStage.tsx`, relay the
   notes under "Also address" after the blocking list. For older reports
   without the field, they use the body's `[note]`/`[nit]` lines instead.
   The re-run brief uses the same summary, so the next QA pass checks the
   notes too. Send-back is still the human's click.

19. User asked to stop re-attaching the same documentation because each
   agent asked for it again. Attachments used to be one-shot, inlined into
   a single message of a single stage. Now `sessions/reference-docs.ts`
   keeps **reference docs** under `state/reference-docs/` (gitignored, never
   in the target repo) at two scopes: a session's (every chat attachment is
   saved there by the four `*/message` routes via `saveAsReferenceDocs`) and
   an app's (added on the Apps page, shared by all its sessions; a session
   doc can be moved there with `/reference-docs/:docId/share`). They are
   indexed like docs/ but with long heading-less text chunked into
   6k-character "(part n of m)" sections. `search_docs` and `read_doc`
   cover them under `reference/app/…` and `reference/session/…` paths.
   `read_doc` returns an outline instead of more than 40k characters. Each
   stage learns what exists from `referenceDocsTurnNote`, prepended to the
   turn prompt and not the system prompt, for the same resume/override
   reasons as step 17. It is sent only when the set changes, tracked in
   `session.referenceDocsSeen`, so it isn't re-billed every turn. Team
   workstreams get the list in their per-run system prompt. An attachment
   over 30k characters is sent as a pointer to its reference path instead
   of in full. Split children inherit copies. Session and app deletion
   remove theirs. UI: a "Reference docs" button on the session header and
   on each app card (`components/DevSessions/ReferenceDocs.tsx`).

20. User asked to spend fewer tokens, using the local Qwen where it helps.
   Measured first: coding was 80-95% of every session, nearly all of it
   cache reads, because one conversation ran across every plan step (the
   worst one: 11 "Continue with the next step" turns, 528 tool calls,
   126.8M tokens) and `read_file` was 70-85% of tool-result text (68 of
   158 reads in that session re-read a file just edited). Now the single
   coding agent starts a **new conversation** (`session.codingContext`:
   step id, start entry, last size) when an automatic step turn is for a
   different step than the conversation started on, for a QA fix
   (`qaFix`), when the last one ended at 90k+ tokens, or when a branch
   exists but no conversation does. Reconciliation turns always resume. A
   continuation hop inside a turn (single agent and team members) compacts
   at 110k instead of resuming (`compaction` in `sdk-client.ts`, which now
   reports each turn's `contextTokens`). Every new conversation opens with
   a handoff (`agents/handoff.ts`): checklist, commits, diff stat and
   `git status` read from the repo, the files changed and read, and notes
   (Done / In progress / Learned / Next) written by local Qwen from the old
   conversation's activity log. Without Qwen, the agent's last message is
   used instead of the notes. On the 126.8M session, one step's 320k
   characters became a 10k-character handoff in about 20s. A compacted
   conversation also gets the full first-turn system prompt back
   (requirements, plan, theme, reference docs), since a resumed turn's
   prompt leaves them out. `read_file` pages are now 300 lines and 16k
   characters. `edit_file`/`write_file` report the lines they changed, and
   the tool descriptions and base prompt say not to re-read a file to check
   an edit. A Qwen docs stage was considered and not built: doc edits are
   a few steps of a coding run, and a 4B model rewriting whole pages
   drops content. Not live-verified with a real coding run yet.

21. User asked for a visual of token usage in Settings. `addStageUsage` now
   also appends each turn's usage to `state/usage-log.jsonl`
   (`sessions/usage-log.ts`; kept after a session is deleted, since the
   tokens were still spent). `GET /api/usage?days=7|30|90`
   (`routes/usage.ts`) totals the log per day, stage, token type and
   session. A session's totals beyond what the log holds (everything from
   before the log existed) are dated to that stage's last transcript
   activity before logging began and flagged `estimated`. UI: Settings →
   Dev Agents → Token usage (`components/DevSessions/TokenUsagePanel.tsx`):
   a range filter, stat tiles, a stacked daily chart by stage with hover
   tooltips and a table view, the token-type split, and the top sessions.
   Stage colors are slots 1-4 of the dataviz reference palette, checked
   with its validator; coding and QA are under 3:1 on white, so the
   legend and the table view are always there.

22. User was still running out of tokens and asked for something like rtk
   (the CLI proxy that compresses shell output for coding agents). The
   agents have no shell, so rtk itself can't sit in front of them; its
   ideas are applied to the tool results in `tool-defs/output-compress.ts`.
   Failed `run_checked_command` / `run_npm_install` / `run_prettier` output
   goes through `compactOutput`: colour codes, progress redraws, npm
   banners and passing-test lines are dropped, repeated lines collapse to
   `(×N)`, and a log still over 3k chars keeps the lines around errors plus
   the last 15 (the runner's summary) instead of a blind 2k tail, which
   used to cut off the actual failure in a long jest run (36k → 0.9k in a
   synthetic test, failure kept). `search_code` groups hits under each file
   and cuts lines at 200 chars. `get_diff`'s overview uses one line of
   context and one-line `### path` file headers (`path` still gives three
   lines of context). `read_file` answers a repeat of an unchanged read in
   the same turn with a one-line note; asking a second time returns the
   text, so a read lost to compaction can still be fetched. Not measured on
   a real session yet; check `state/usage-log.jsonl` before and after.

23. User asked why agents weren't using the repo's docs as an index. Only QA
   and plan were told to `search_docs` first, and doc upkeep covered
   behavior, not where code lives. Now:
   - **Docs first**: the coding, team-member and QA prompts say docs →
     `search_code` → `outline_file` → ranged `read_file`; where docs and
     code disagree, the code wins and the doc gets fixed.
   - **Code map upkeep**: a step that adds/moves/removes a module, folder,
     route, handler or table updates the code-map page (usually
     `docs/architecture.md`, one line per entry, no signatures or line
     numbers). A repo with no map gets a short one from the first coding
     step. The plan agent names the map update in the step that adds the
     module, and in team mode gives doc pages to one workstream that
     depends on the ones they describe (members can't write outside their
     paths, and their summaries aren't stored for a lead to apply). QA
     flags a missing map entry as non-blocking.
   - **Docs index watcher fix**: `repo/docs-index.ts` watched a
     `docs/**/*.md` glob, which chokidar 4 doesn't support, so the index
     never refreshed until a server restart and docs written mid-session
     weren't searchable. It now watches the directory and ignores non-`.md`
     files (verified: a new doc is searchable within ~1s).
   - **`search_code`** searches every tracked file (it was `src/` and
     `infra/` only, so other layouts found nothing and agents fell back to
     whole-file reads), skips `NOISE_PATHSPECS` (shared with `get_diff`),
     takes `context` 0-3 (`git grep -C`), allows 10 matches per file when
     `glob` narrows it, and passes the query with `-e` so it can't be read
     as a flag. Output is `-z` and grouped per file.
   - **`outline_file`** (`tool-defs/outline-tool.ts`, in every agent that
     has `read_file`): TS/JS via the `typescript` compiler API (imports,
     functions, classes and methods, types, consts, describe/it blocks,
     each with its line range), markdown headings, otherwise the
     shallowest-indented lines. `coding-agent.ts` (25k chars) outlines in
     1.1k.
   - **Tool output measurement**: `runAgentTurn`/`runClaudeAgentTurn` count
     each tool result's characters per tool (`ToolOutputStats`, MCP prefix
     stripped) and put them on the `usage` event; `addStageUsage` writes
     them into `usage-log.jsonl`, `GET /api/usage` returns `toolOutput`, and
     the Token usage panel shows a "Tool output" breakdown (≈ chars ÷ 4
     tokens). Use it to pick the next thing to trim — a `typecheck` check
     and related-tests-only runs were deferred until it shows check output
     matters.

24. User asked for search to be done the same way everywhere, with search by
   meaning. `search_docs` no longer scores sections itself
   (`scoreSections`/`searchDocs`/`searchReferenceDocs` are gone): it runs
   Riff's search engine, the `riff-search` crate also behind the app's
   meeting and journal search (root CLAUDE.md, "Search"), as a child
   process: `search/search-engine.ts` spawns `$RIFF_SEARCH_BIN --search-stdio`
   (Riff sets it to its own binary; otherwise `target/{release,debug}/riff-search`
   or `riff` in this checkout) with `--index state/search.sqlite` and Riff's
   embedding model dir, and talks JSON lines with request ids. Keyword
   search is FTS5 with stemming; with Riff's embedding model downloaded,
   it's fused with search by meaning, so a question finds the section
   that answers it in other words. Docs and reference docs stay in memory
   for `read_doc`; `toSearchDocuments` turns them into one search document
   per file with a segment per section, so a hit's heading is exactly what
   `read_doc` takes. Before each search, `syncScope` sends only documents
   whose fingerprint changed (an unchanged scope costs nothing). Scopes:
   `app:<id>:docs`, `reference:app:<id>`, `reference:session:<id>`; deleting
   an app or session drops its scopes. The tool asks for 12 hits and shows
   4, one per section. Without a built Riff the tool throws
   `SearchUnavailableError`. Live-verified with a scratch app: meaning-only
   questions ("how long does someone stay logged in" → Sessions), a session
   reference doc, a keyword match, and nonsense returning nothing, at
   4-13 ms per search.

25. User said cache reads were still high after steps 20 and 22. The usage
   log showed coding at 86% of cache reads, with 4-6.5M per coding turn.
   The Claude SDK's own transcripts (`~/.claude/projects/<repo>/<id>.jsonl`,
   one usage record per request) showed why. Request 1 of a coding
   conversation was already ~52k tokens. That was the system prompt (73k
   chars, half of it the whole plan doc), the target repo's CLAUDE.md (30k,
   loaded by `settingSources: ['project']`), tool schemas (21k) and the
   handoff (13k). Context then grew to ~117k over ~70 requests. Compaction
   only ran between 20-step hops at 110k, so it rarely ran. That came to
   about 70 × 88k ≈ 6.2M, and 59% of it was the starting context. Now:
   - **Plan excerpt** (`agents/plan-excerpt.ts`): the coding system prompt
     has the plan without frontmatter, everything outside `## Steps`, the
     current step (team members: their steps) in full, and the other steps
     one line each. Steps are matched to their `### ` sections by title,
     else by position, else the whole plan is kept. `read_doc` serves
     `session/plan.md` and `session/requirements.md` from artifacts/.
     consolidate-ui's approved docs went from 45.5k to 20k chars.
   - **No auto-loaded CLAUDE.md**: `CLAUDE_ISOLATION.settingSources` is
     `[]`. Every role's first-turn prompt gets `repoInstructionsNote` (its
     top-level headings, <1k chars), and `read_doc` serves `CLAUDE.md` by
     heading (a bare heading works). `splitIntoSections` now skips fenced
     code blocks. A `# comment` in a shell snippet had been read as a
     heading, which scrambled heading paths for docs search as well.
   - **Shorter hops**: `CompactionOptions` takes `stepsPerHop`/`maxHops`.
     The single agent and team members run 10 × 8 hops (same 80-step
     ceiling) and compact at 70k (`COMPACT_AT_TOKENS`). A new turn starts a
     fresh conversation at 60k. A hop only compacts once the conversation
     has grown 20k past where it started, so long approved docs can't make
     every hop compact.
   - **Fewer requests**: `edit_file` takes `edits: [{oldText, newText}]`
     for one file, all or nothing, and `$` in newText is now literal.
     `write_coding_plan` merges by id: pass just the steps that changed,
     with `replace: true` for the seed and reconciliation. A new id goes
     after the step listed before it. Its result is a one-line count, not
     the whole list echoed back. The prompts say to batch independent calls
     into one message.
   - Smaller: the handoff lists finished steps by id only and keeps 15
     commits. The read_file, write_file, run_npm_install,
     run_checked_command and run_prettier descriptions were trimmed.
   Not live-verified with a real coding run yet. To check, compare request
   1 and the per-request context in the new SDK transcript, and the
   turn's line in `state/usage-log.jsonl`, against the numbers above.

26. User asked for Jack, the coding lead, to decide whether work splits
   across a team instead of the plan stage, and for QA send-backs to be
   parallelized the same way. **Supersedes step 10's planning half.**
   `write_plan_doc` no longer takes `workstreams` and the plan prompt no
   longer plans a team (it still lists each step's files, which Jack reads
   to decide). The coding agent got `assign_team`
   (`tool-defs/assign-team-tool.ts`): optional new `steps` (id, title,
   `brief`) plus `workstreams` covering every unfinished checklist step,
   validated by `agents/team/workstreams.ts` (step 10's rules, moved from
   `sessions/plan-doc.ts`, which is gone). It only records the split as
   `session.codingTeam` with status `assigned`, a `round` and a `kind`
   (`plan` | `qa-fix` | `follow-up`); the previous round moves to
   `codingTeamHistory`. The Coding tab starts the team once Jack's turn
   ends, once per round, so the team never runs while Jack is in the main
   checkout. Jack is asked to decide at kickoff (first-turn section; the
   kickoff turn is never light-routed) and on a QA fix (`QA_FIX_TEAM_NOTE`
   in the turn prompt). The criteria live in the tool description, since an
   app's prompt override replaces the base prompt. QA-fix steps carry a
   `brief` the engineer gets in its workstream section, because members see
   the plan but not the QA report. `write_coding_plan` merges keep briefs.
   Round 1 keeps bare-id branches/worktrees, later rounds use `r<n>-<id>` so
   an earlier round's unmerged branch can't collide. Once a round has
   finished, Jack's next turn starts a new conversation (`codingContext.teamRound`)
   so Jack's system prompt shows what the team merged. The coordinator says
   "ready" while a team is assigned or running, and after a round until
   someone talks to Jack again. Verified on a scratch copy with a stub
   engineer: validation, kickoff split, merge, a QA-fix round with briefs on
   `r2-` branches, and a failed member. Not run with real agents yet.

27. User asked to run the agents on their local models — a Qwen in the
   system's Ollama alongside Riff's built-in one. Added an "ollama"
   provider (`settings/settings.ts`): every role, the light model and
   team workstreams can select it like the cloud providers. It takes no
   API key — `providerNeedsApiKey()` is false for it, and the new
   `getApiKey()` in settings-store.ts returns the stored key, or '' for
   keyless providers, or null only when a keyed provider has none (the
   agents' "No API key" checks now test `=== null`). `settings/ollama.ts`
   owns the endpoint: stored as `ollamaEndpoint` in local-settings.json
   (default http://localhost:11434, editable in Settings), lists
   installed models with their `tools` capability from GET /api/tags
   (`GET /api/settings/ollama/models` feeds the pickers' datalists), and
   `testOllama` backs the Settings Test button (reachable + model
   installed + tools-capable). Engine side, `resolveLanguageModel()` is
   now async and builds `createOpenAI({ baseURL: '<endpoint>/v1' }).chat(model)`
   — Ollama's OpenAI-compatible API, which its tool-capable models speak
   natively (verified live: a `runAgentTurn` smoke on `qwen3.8:27b` did
   the read→write tool loop and reported usage). `KNOWN_MODELS.ollama`
   is `[]` (live list instead) and `DEFAULT_LIGHT_MODEL.ollama` is `''`
   (light routing off until a cheaper model is picked — see the
   LightStepsRow's no-default handling in DevAgentSettings.tsx). Riff's
   built-in Qwen (step 12) is unchanged: llama-helper has no tool
   calling, so it stays on the coordinator's single-shot decisions,
   handoff notes and delivery text; the coordinator still tries it first
   even when its fallback provider is ollama.

28. User was running out of context on paid agents and asked for local
   subagents that do small tasks in parallel and return only what the main
   coding agent needs. The goal is saving tokens: if a helper finds nothing
   useful, the paid agent should pay almost nothing for it. The coding agent
   and team members got `delegate` (now `helpers/research/`, see step
   29). It's only registered when
   `models.coding.delegateModel` names an Ollama model and the turn isn't
   already on Ollama. An AI-SDK history that still has delegate calls keeps a
   refusing stub so replays stay valid (`delegateToolEntry`, like
   `fetch_url` in step 17).
   - **Helpers**: each task runs `runAgentTurn` on Ollama with an empty
     history and its own read-only tools: `search_code`, `search_docs`,
     `read_doc`, `outline_file`, and `read_file` with 150-line pages and its
     own repeat-read cache. A helper gets 12 steps, no continuation and
     a 3-minute `abortSignal` (new optional `RunAgentTurnParams.abortSignal`).
     Two run at a time (`DELEGATE_PARALLEL`), since one GPU serves them all.
     Their events never reach the paid agent's stream.
   - **Returning less** (`helpers/research/core.ts`, pure, tested by
     `frontend/tests/harness-server/research-core.test.ts`): the helper
     prompt asks for path:line facts, under 150 words, and `NOTHING_FOUND`
     instead of a guess. `cleanAnswer` drops `<think>` blocks, preamble and
     sign-off lines, treats NOTHING_FOUND (bare, in markdown, or explained)
     as nothing, and cuts at 1,200 chars. `formatResults` returns one answer
     bare, numbers several, and folds every empty task into "Nothing found:
     2, 3." and every failure into one "Failed, do yourself" line. Running
     out of steps counts as nothing found.
   - **Savings**: `savedTokens` = characters the helpers' tools returned
     minus the text handed back, ÷ 4. It's a lower bound, since a result in
     the paid context is also re-read on every later step.
     `addDelegateUsage` appends a `usage-log.jsonl` entry with
     `delegate: { tasks, useful, savedTokens }` and the helpers' local
     usage, and doesn't touch `session.usage`. `GET /api/usage` leaves
     those entries out of every paid total (and out of the pre-log
     estimate) and returns them as `local`. The Token usage panel opens with
     "Saved by local helpers".
   - The guidance is in the tool description and in `DELEGATE_NOTE`, which
     is appended to the system prompt after any prompt override.
   - **In the chat**: each run also records a system transcript entry
     carrying `delegate: DelegateRunStats` (model, tasks, useful,
     read/returned chars, saved tokens), written just before the tool
     result. `tool_result` entries now carry `toolName` (persisted and in
     the live overlays), so `ChatPane` shows a delegate call as "Asked local
     helpers N questions" with the list. The result card shows exactly what
     the paid agent got back, with that run's stats line folded in. The
     stats entry itself isn't rendered on its own.
   - Ollama's context window: if helpers come back empty on large files,
     raise it (`OLLAMA_CONTEXT_LENGTH`).
   - Live-checked on qwen2.5:7b-instruct against this backend with 3
     questions in 18s: 2 answered with path:line, 1 "Nothing found: 3." The
     helpers read 4.9k chars and 435 came back. A trailing `NOTHING_FOUND`
     after a real answer is stripped. It hasn't run inside a real coding
     session yet.

29. User asked for the classification code to be a form of helper agent.
   The two local-model tools became one family under `agents/helpers/`,
   with no change to what agents see: tool names, schemas and prompts are
   the same.
   - `helper.ts` is the contract. A `HelperContext` (session, stage, how to
     add a chat entry) is passed to each helper's tool factory, and every
     run goes through `reportHelperRun`. That writes one usage-log line,
     `helper: { name, tasks, useful, savedTokens }`, replacing step 28's
     `delegate` field (none had been logged), and one system chat entry,
     `helper: HelperRunStats`, replacing `delegate`. Reporting never fails
     the tool call.
   - `helpers/research/` is step 28's `delegate`. `delegateDeps` and
     `delegateToolEntry` moved there from coding-agent.ts.
   - `helpers/classifier/` is the old `classification*.ts`,
     `pipeline-cache.ts` and `tool-defs/classify-text-*`, plus the Claude
     wrapper. `classifyTextTool` (a constant) became
     `createClassifyTextTool(context)`, and every agent builds it with
     `stageHelperContext(session.id, stage)`. Team members use their own
     transcript.
   - A classifier run has no tokens and no measurable saving
     (`savedTokens: null`), so it's counted, not estimated.
   - Requirements, plan and QA now also store `toolName` on `tool_result`
     entries, like coding did in step 28.
   - UI: `components/DevSessions/HelperBubbles.tsx` maps tool → helper and
     renders the call and result cards. The classifier result shows each
     label's score bar, with the picked ones highlighted. `ChatPane` only
     dispatches. `GET /api/usage`'s `local` is `{ calls, savedTokens,
     usage, byHelper }`. Settings → Dev Agents has one "Local helpers"
     section (Research helper + Classifier helper).

30. User asked where a session's logs showed wasted tokens and time, and
   why agents in the app ran slower than Claude Code in VS Code. Session
   `2c8f3fdc` showed the local helpers costing more than they saved, so:
   - **Runner** (`helpers/runner/core.ts`): Qwen used to replace a failed
     run's whole report, junit summary included. It listed 1 of 7 failures
     and once ended "7 failures / All passed.", and the agent re-ran the
     suite 3 times. Now the pass/fail line and junit summary (each failing
     test now carries its first failure line) always go through unchanged,
     and Qwen only shortens a raw log over 5k chars, listed under them.
   - **read_file compression** is off for the coding agent and team members.
     A compressed read cost 7-30s on the serialized Qwen and sent the agent
     back for a ranged re-read (one file read 10 times in a turn). QA keeps
     it, and Qwen's markdown fences are stripped.
   - **delegate** is gone from QA, which redid every answer it got ("too
     terse to trust", "contradictory"); a refusing stub keeps old histories
     valid. For coding and team members, `RedoLedger` (research/core.ts)
     remembers the files each answered delegation read. The first paid
     `read_file` of one (`FileToolDeps.onRead` → `noteDelegateRead`) logs a
     `redo: true` usage line that cancels that run's useful count and
     saving, so "Saved by local helpers" no longer counts work done twice.
   - **git_commit** says why it rejected a message (`commitMessageProblem`):
     the agent sent three valid `fix:` messages whose subjects were over 72
     chars before one passed. A body after a blank line is now accepted.
   - **Hops**: the Claude engine runs 20-step hops × 4 (`hopLimits`), since
     each hop's `query()` boots a Claude Code subprocess. The AI SDK engine
     keeps 10 × 8.
   - **Transcript/UI**: `tool_call`/`tool_result` entries store
     `toolCallId`, and `ChatPane` pairs by it (older entries by name and
     order), since parallel calls finish out of order. The Coding tab no
     longer refetches the multi-MB session and diff after read-only tools,
     and stops polling a team run the server says isn't running.
   Not yet checked against a real coding run. To check, compare a coding
   turn's request count, `run_checked_command` repeats and helper lines in
   `state/usage-log.jsonl` against the numbers above.

31. User asked again where the logs showed waste. In session `2c8f3fdc`'s
   last coding turn (~150 requests, 4.3M cache reads) the agent ran the
   tests 17 times and had a test write its call count to a file, because it
   could never see why a test failed. Fixed:
   - **`compactOutput`** (`tool-defs/output-compress.ts`): the
     `:\d+:\d+` location pattern also matched every ISO timestamp, so a
     vitest run's `stdout | file > test` console blocks filled the 3k
     budget, first come first served, and the real failure (on stderr) was
     skipped. The closing "last 15 lines" were npm's stderr exit report, and
     a final `slice(-maxChars)` cut the first line in half. Now a location
     must be `file.ext:line`, console blocks are never kept once a log is
     over budget, npm's `code`/`path`/`location`/`command` lines are noise,
     and the closing lines are the last 10 of each stream (stdout's totals
     first). The budget is filled summary first and the result never cuts a
     line (`frontend/tests/harness-server/output-compress.test.ts`).
   - **Runner**: `compactOutput` capped the log at 3k, so step 30's 5k
     threshold meant Qwen never ran. Qwen now reads the log compacted to
     `RUNNER_INPUT_CHARS` (24k, inside llama-helper's 16k-token context),
     and `groundSummary` keeps only lines the log backs up: every
     `path:line` must be in it, as must `path > first test-name segment`,
     and verdict/count lines are dropped. Earlier summaries had paired the
     real test with another file and said "7 failures / All passed.". A
     rejected summary logs a `useful: 0` runner line and sends the excerpt.
     A `junit.xml` older than the run is ignored instead of reported as
     this run's.
   - **`search_code`** ran `git grep` with basic regex, so `a|b` searched for
     a literal pipe: 79 of 94 such searches across all sessions found
     nothing. It now uses `-E`, retries a pattern that isn't valid ERE
     (exit 128) with `-F`, and when no line matches lists tracked paths that
     match (`matchPaths`), since agents look files up by name with it too.
     The path listing skips `NOISE_PATHSPECS`: `git ls-files` returns nothing
     at all when a wildcard pathspec is combined with an exclude one.
   - **Repeat-read notes** (`tool-defs/read-memo.ts`): `read_file`'s and
     `read_doc`'s "unchanged since you last read it" memory lived as long as
     the turn, so after a mid-turn compaction it answered reads from the
     previous conversation with a note, and the agent had to call again (41
     times in one session). The coding agent and team members now share one
     `ReadMemo` across both tools and clear it in `compaction.handoff`.
   - **Bare tool names**: on the Claude engine the first calls of a new
     conversation were sometimes `read_file`/`search_code`, which the
     prompts use, and came back "No such tool available" (up to 10 per
     session; Claude Code's tool search wasn't involved). Every
     `runClaudeAgentTurn` system prompt now ends with a note mapping bare
     names to `mcp__harness-tools__<name>`.
   Not yet checked against a real coding run.

32. User asked that the team only run when parallel work makes sense, and
   never mess up the git history. Owned paths limited only file writes, so
   commits could still pick up other files. A team member's `git_commit`
   (`GitToolDeps.writablePaths` → `stageAndCommit`'s `scope`) refuses files
   outside its owned paths, and a catch-all commit stages only those paths.
   Before the final auto-commit, `coding-team.ts` discards uncommitted
   changes outside them (lint --fix, snapshots, a lockfile, build output)
   and notes them in the member's chat. A branch whose commits still touch
   other files (a hook, say) fails instead of merging. `mergeBranch` takes
   the session branch and refuses if the main checkout has moved to another
   branch or is dirty (another session or the human may be using it). A
   member that already finished, so only its merge failed, resumes straight
   to the merge. `validateWorkstreams` rejects a split whose longest
   dependency chain is over `MAX_CRITICAL_SHARE` (75%) of the work, with
   light plan steps counted as half. `assign_team` gives the workstream that
   owns `package.json` the lockfile too. Tests:
   `frontend/tests/harness-server/coding-team-git.test.ts` (temp repo).

32. User asked for the QA agent to be parallelized like coding, reusing as
   much code and UI as possible. Tess, the QA lead, got `assign_qa_team`
   (`tool-defs/qa-team-tools.ts`): 2+ reviewers, each with its own
   acceptance criteria (every criterion to exactly one reviewer; "Docs to
   update" counts as one), focus paths and a brief, validated by
   `agents/team/qa-review-areas.ts`. Like `assign_team` it only records
   `session.qaTeam` (`assigned`, a `round`; the previous round moves to
   `qaTeamHistory`), and the QA tab starts it once Tess's turn ends.
   `agents/team/qa-team.ts` (`POST /qa/team/run`, the same `TeamEvent` SSE
   as the coding team plus `team_check`) runs every reviewer at once and,
   alongside them, lint then the unit tests (one after the other: they share
   `junit.xml`), storing results in `qaTeam.checks`. Reviewers are read-only,
   so there are no worktrees, owned paths, dependencies or merges: they share
   the main checkout. A reviewer (`team/qa-reviewer-agent.ts`) is the QA
   prompt (or override) + `prompts/qa-team-reviewer.md` + its criteria, with
   QA's read-only tools (`createReviewTools` in qa-agent.ts, shared with the
   lead) plus `submit_review`, which stores `QaReviewFindings` on the member.
   No `run_checked_command`, report or questions. One that ends without
   submitting is `failed`; the run is then `needs_attention`, and resuming
   reruns only reviewers without findings, from a fresh conversation, and
   only checks that never finished. Once a round is `done` the QA tab sends
   Tess a wrap-up message; Tess's next turn, whoever sends it, is prefixed
   once (`qaTeam.relayed`) with `formatQaTeamFindings`: check results (failing
   output only), every reviewer's verdicts and findings, and the criteria of
   any reviewer that didn't report. She writes the one report. A QA rerun
   after fixes retires the team to history, so the fresh pass decides again.
   The coordinator says "ready" while a QA team is assigned or running.
   Reviewer usage counts toward the QA stage. UI: the team board moved from
   `CodingTeam.tsx` into the generic `AgentTeam.tsx` (`TeamPanel`,
   `EarlierRounds`, `PathChips`); `CodingTeam.tsx` and `QaTeam.tsx` are thin
   wrappers, and `lib/dev-sessions/useTeamBoard.ts` (run, poll, auto-start
   per round, live overlays) drives both stages. Reviewers have their own
   pun-name roster (`qaReviewerPersona`) and Tess shows as "QA Lead".
   `CodingPlanChecklist` takes a `failed` item state and a count label so it
   shows a reviewer's criteria (met / not met / unverified). Verified on a
   scratch copy with a stub reviewer: validation, concurrent reviewers and
   checks, a reviewer that didn't submit, resume, a second round and boot
   recovery; `frontend/tests/harness-server/qa-review-areas.test.ts` covers
   validation and the findings text. Not run with real agents yet.

33. User asked for a split to be smart about build order, track what got
   done, and let them go back to the original session to continue with the
   smaller parts. `sessions/split-roadmap.ts` (pure, tested by
   `frontend/tests/harness-server/split-roadmap.test.ts`) derives a roadmap
   from the parent's `splitInto` + `splitProposal` and the children. It is
   never stored, so it can't drift. Each part's status is `not-started`
   (no requirements chat yet), `in-progress`, `shipped` (stage `done`),
   `dropped` (abandoned) or `missing` (deleted). `blockedBy` lists its
   unshipped dependencies, and `nextIndex` is the earliest unshipped part
   with none. `split-roadmap-load.ts` loads it for the parent or any part:
   - `GET /api/sessions/:id/roadmap`.
   - A part's kickoff also attaches a progress note
     (`roadmapProgressBrief`): every part's status in order, plus each
     shipped part's outcome and acceptance criteria. The split-time brief
     can't know what has shipped by the time the part starts.
   - `plan/approve` answers 409 `dependencies_not_shipped` for a part whose
     dependencies haven't shipped, since its branch would start without
     their code. `{ ignoreDependencies: true }` overrides that, for when
     the human merged the dependency by hand.

   `propose_split` parts take a required `outcome` (what works once the
   part ships). Its schema and the prompt now say how to order parts:
   what other parts need first, then a thin end-to-end slice, riskiest
   unknowns early, and `dependsOn` only for real needs.

   UI: the parent's Requirements tab shows the roadmap (`ParentRoadmap` in
   `SplitPanel.tsx`): progress bar, ordered parts with status, outcome,
   what each is waiting on, delivery, and a "Continue: <next part>" button.
   Every part shows `SplitPartStrip` under the stepper, with its place,
   what it's waiting on, "Next part" once shipped, and the roadmap
   expandable. The Plan tab disables Approve while dependencies are
   unshipped and offers "Approve anyway". The sessions list shows "n of m
   parts shipped" and "part n of m".

   Verified on a scratch server copy: propose (incl. the ordering check),
   accept, the roadmap, the 409, the progress note after a part shipped,
   and approval once unblocked. Not run with real agents yet.

**On terminology**: "Anthropic" in this codebase always means the
API-key-billed path (console.anthropic.com); "Claude" always means the
subscription/OAuth path (`claude login`). Keep that distinction consistent
in code, prompts, and UI copy — the two are easy to conflate by name alone
since both ultimately run Claude models.

## Architecture

```
backend/src/
  config.ts              — this project's own root/state paths only now (harnessRoot, artifacts dirs, port) — no target-repo fields, see apps/ below
  server.ts               — Fastify bootstrap: builds/watches a docs index per app, registers all routes
  apps/
    apps.ts                 — AppConfig type, validateRepoRoot()/docsDirFor()/readRepoUrl() (per app, not stored/cached — read fresh so a repoRoot edit can't leave a stale docsDir/repoUrl around), LEGACY_APP_ID. validateRepoRoot() only requires an absolute path to a folder (or a not-yet-existing one whose parent exists) — no package.json, docs/ or .git needed, so a brand-new app can start from an empty folder. createApp/updateApp (never the read-only /api/apps/validate check) create the folder and docs/ via ensureDocsDir(), then run repo/git.ts's setupGitRepo(): a folder that isn't its own repo gets `git init` on master + starter .gitignore + initial commit; an existing repo only gets the new docs/README.md committed if it's on its base branch. AppConfig.baseBranch (detected: master, else main, else HEAD; missing on old apps → baseBranchFor() returns "master") replaces the old hardcoded master in every git.ts diff/branch helper
    apps-store.ts            — reads/writes backend/local-apps.json; seeds one app from the legacy TARGET_REPO_ROOT env var the first time it's read if that file doesn't exist yet
  sessions/
    session.ts             — SessionRecord type: appId (which app this session drives) + stage machine, transcripts (UI display) + histories (ModelMessage[] per stage, for conversation continuity)
    session-store.ts        — flat-file JSON persistence, one file per session under state/sessions/; normalizeSession() defaults a pre-multi-app session's missing appId to LEGACY_APP_ID
  settings/
    settings.ts             — Provider/Role types (incl. "ollama" — the system's Ollama server, keyless), KNOWN_MODELS (curated, not exhaustive — any model ID works; ollama's comes live from the endpoint), ollamaEndpoint + its normalization, redaction
    settings-store.ts       — reads/writes backend/local-settings.json; getApiKey() = stored key, '' for keyless providers (claude/ollama), null only when a keyed provider has none saved
    ollama.ts               — the "ollama" provider's endpoint: listOllamaModels() (installed models + tools capability from /api/tags), testOllama() for Settings' Test, openAICompatBase() for the engine
    prompts-store.ts          — per-app, per-role system prompt overrides; reads/writes backend/local-prompts.json, seeds the legacy app's overrides from prompts/customer-edi-legacy/*.md the first time it's read
  agents/
    handoff.ts               — the opening note of a new coding conversation (step boundary, QA fix, compaction): repo state + Qwen-written notes on the previous conversation
    sdk-client.ts            — BOTH engines: runAgentTurn() (AI SDK: resolveLanguageModel() switches on ApiKeyProvider — "ollama" builds createOpenAI().chat() against <endpoint>/v1, everything else uses the pasted key — then streamText() with stopWhen: stepCountIs(20)) and runClaudeAgentTurn()/testClaudeLogin() (Claude Agent SDK: query(), MCP server, resume: sessionId, cwd: the session's app's repoRoot) — both normalize to the same AgentEvent union so routes/frontend don't care which ran
    requirements-agent.ts, plan-agent.ts, coding-agent.ts, qa-agent.ts — one per role: resolve the session's app, load prompt (app override, else the checked-in base) + role's model config, branch on provider === 'claude' to pick engine + matching tool set (tool-defs/ vs tool-defs-claude/) built against that app's repoRoot, persist transcript + (history or claudeSessionId)
    prompts.ts                — readBasePrompt(role): the checked-in file for a role, or coordinator-agent.ts's DECISION_INSTRUCTIONS constant for "coordinator" (which has no file) — used by the Apps page's "view base prompt"
    prompts/*.md             — app-generic base system prompts (no target-repo specifics)
    prompts/customer-edi-legacy/*.md — verbatim archive of the original Customer-EDI-specific prompt content, seeded as that app's prompt overrides (see prompts-store.ts above)
    helpers/                  — local helpers: work an agent hands to a model on this machine instead of its paid context (step 29). helper.ts is the shared contract (HelperContext, reportHelperRun → one usage-log line + one chat entry per run, stageHelperContext). Each helper folder: core.ts (pure, tested from frontend/tests/harness-server/), the runtime, tool.ts (AI SDK) + tool-claude.ts (Claude engine)
    helpers/research/         — `delegate` (step 28): core.ts (schema, answer cleanup, formatting, savings, runDelegation), tool.ts (Ollama helper loops, delegateDeps, delegateToolEntry)
    helpers/classifier/       — `classify_text`: classifier.ts is on-device zero-shot classification (all four roles + team members), a transformers.js pipeline over a small ONNX NLI model. It's one in-process singleton, hot-swapped when Settings → Dev Agents picks another of the three curated models, with weights cached under state/classification-models/ (not transformers.js's own OS cache). It also has the cache status/clear helpers routes/settings.ts exposes. It is deliberately NOT local-llm.ts's Qwen/llama.cpp stack, which is a causal chat model on a different runtime (see docs/classification-tool.md in the Riff repo). cache.ts is the on-disk half: recursive size walk, per-model cache status, clear-all; it takes the cache dir as an argument so it's tested against a temp dir. pipeline-cache.ts is the in-memory half: a single slot keyed by model id with an injected loader. core.ts holds the pure normalization/ranking/selection, and schema.ts the zod schema + description, importable by tests without `ai`. Optional tool params are `.optional()`, never zod `.default()`: a default makes the argument required on the Claude/MCP path
    tool-defs/*.ts            — one file per tool group (the local helpers' tools live in helpers/ instead); each exports schema + description + a factory (createXExecute(s)/createXTool(s)) that closes over a repoRoot/appId, built fresh per turn by the *-agent.ts files
    tool-defs-claude/*.ts     — same tool groups, Claude-Agent-SDK tool() wrappers around the SAME factory-produced execute functions from tool-defs/ via wrap.ts's wrapForClaudeSdk() — no logic duplicated, only the SDK-format glue
  repo/
    guardrails.ts             — assertPathAllowed(path, allowedRoots, repoRoot), shared path-allowlist used by every general-purpose file tool (not by the dedicated requirements/QA-report writers, which write directly via fs and bypass this)
    git.ts                     — simple-git wrapper, every export takes repoRoot: branch preconditions, commit, diff against master
    docs-index.ts               — per app (Map<appId, sections/indexedAt/watcher>) sections of <app.repoRoot>/docs/**/*.md for read_doc, fed to Riff's search engine for search_docs (step 24)
  search/search-engine.ts        — client for Riff's search engine (`riff --search-stdio`): syncScope by fingerprint, searchIndex
  routes/                       — one file per resource: sessions, requirements, plan, coding, qa, settings (incl. `GET /api/settings/classification-cache` and `POST /api/settings/classification-cache/clear` for the classify_text model cache), apps (apps + their prompts/integrations/openapi/handbook), coordinator

frontend/src/
  pages/                        — SessionList, RequirementsStage, PlanStage, CodingStage, QaStage, SettingsPage, AppsPage (app CRUD + per-app prompt overrides), IntegrationsPage/ApiSpecPage (now per-app, under /apps/:appId/...)
  lib/useAgentTurnStream.ts       — shared SSE-consuming hook (chat streaming), used by all stage pages
  lib/sse-client.ts                — manual SSE parsing over fetch (POST bodies can't use native EventSource, which is GET-only)
  components/DiffViewer.tsx        — hand-rolled unified-diff renderer (skipped react-diff-viewer-continued — it re-diffs two full-text strings, doesn't consume an existing unified patch, which is what git diff gives us)
```

## Tool error convention

`execute()` either returns normally or throws — there is no third
"isError" flag. Which one to use depends on what the failure means:

- **Throw** when the requested action was structurally invalid and
  execution didn't really happen: path outside an allowlist, git
  precondition failed (dirty tree, wrong branch), `edit_file`'s oldText not
  found/not unique, doc not found. The model needs to see "that didn't
  work" distinctly from a real result.
- **Return normally** (with pass/fail embedded in the returned text) when
  the tool DID run and produced a legitimate result the model needs to
  reason about: `run_checked_command` (lint/test failing is information,
  not a broken tool call), `run_generate_paths`/`run_generate_openapi`
  (same reasoning), `search_code`/`git grep` finding zero matches.

## Running / testing this project

```bash
npm start        # from this directory: install (idempotent) + dev, opens browser
```

Needs Node **≥22** (the `ai` package's own engine requirement — this
project itself has no `engines` field, deliberately, after the EBADENGINE
incident in step 2 above). The sandbox this was built in defaults to Node
20; use `/opt/homebrew/opt/node/bin/node` (or whatever resolves to 23.x) via
`PATH=...` prefix for any live testing here.

Type-check: `tsc --noEmit` in `backend/` and `tsc -b --noEmit` in
`frontend/` (uses the hoisted workspace-root `node_modules/.bin/tsc` since
npm workspaces hoist devDependencies — `backend/node_modules/.bin` doesn't
exist standalone).

## Current status / what's verified

- Full pipeline (requirements → coding → QA, all three gates, reject
  endpoints, docs grounding, git branch/commit tools, lint/test tool,
  Settings CRUD) is built and type-checks cleanly on both sides.
- **Live-verified, multi-app (step 7)**: against the already-running dev
  server, confirmed the legacy-env seed produces the `customer-edi` app
  with the correct `repoRoot`/`docsDir`/`repoUrl`, `local-prompts.json`
  seeds that app's overrides from `prompts/customer-edi-legacy/*.md`
  verbatim while `/api/apps/:id/prompts` returns the new generic base text,
  pre-existing session files (predating `appId`) come back defaulted to
  `customer-edi`, `POST /api/sessions` without `appId` is rejected, and
  `POST /api/apps/validate` correctly rejects a non-repo path. Also added a
  second scratch app and ran a real requirements-agent turn against it end
  to end (Claude engine, `mcp__harness-tools__search_docs`) — this is what
  caught a real bug before it shipped: `POST /api/apps`'s
  `buildDocsIndex()` immediately followed by `watchDocsForChanges()`, whose
  first line called what was then a shared `stopWatching()` that also
  deleted the just-built `sectionsByApp`/`indexedAtByApp` entries, so
  *every* app's docs index (including the boot-time loop for the existing
  Customer-EDI app) was silently wiped right after being built — search_docs
  always came back empty. Fixed by splitting `stopWatching()` (watcher only)
  from a new `removeIndex()` (watcher + cached sections, used only on actual
  app deletion). Re-verified after the fix: the second app's search_docs
  returned only its own content, and Customer-EDI's own search_docs still
  answered correctly from its real docs — confirmed apps' indexes are
  properly isolated, not just individually functional.
- **Live-verified, auto-initializing docs/ on app creation**: adding a real
  repo with no `docs/` folder yet (`/Users/rifaz/rally`, which does have a
  `package.json`) against the running dev server — `/api/apps/validate`
  returned `ok: true` with an informational note instead of rejecting it,
  and `POST /api/apps` actually created `docs/README.md` on disk and
  reported `docsInitialized: true`.
- **Live-verified, "claude" provider (current engine)**: `claude login`
  ambient-credential detection via `/api/settings/test`; a full real
  multi-tool-call requirements-agent conversation (search_docs called
  twice, real doc content returned, correct synthesized answer) — this is
  the strongest end-to-end proof the dual-engine architecture and the
  tool-defs/tool-defs-claude split both actually work, not just type-check.
- **Live-verified, AI-SDK engine (anthropic provider)**: settings
  save/test/redact all correct; a real network call to Anthropic with a
  deliberately fake key correctly round-tripped a clean rejection
  ("API key is invalid.") — proves `resolveLanguageModel` →
  `createAnthropic` → `streamText`/`generateText` → error handling all
  work end to end; the "no API key configured" guard fires correctly.
- **Still not live-verified**: an actual successful multi-turn tool-calling
  conversation through the AI-SDK engine specifically (only auth-boundary
  behavior was exercised there — the claude-provider test above proves the
  *tool logic* works, but not the AI-SDK wrapper format specifically), and
  OpenAI/Google concretely (no keys were available to test past auth). Also
  still unverified: the coding agent's actual branch-creation success path
  on any provider (only the precondition-failure path has been exercised —
  the working tree during development was never clean enough to test the
  happy path without stashing real work).

## Things deliberately not built

- No "Request changes" as a distinct UI action — the chat stays open until
  you explicitly Approve, so giving feedback and continuing the
  conversation already does this; a dedicated button would just wrap
  "type in the box."
- No agent can push, merge or open an MR. Delivery (`repo/delivery.ts`,
  `GET/POST /api/sessions/:id/delivery`) is a human click on the QA tab,
  only once QA is marked reviewed. It detects the repo shape itself: no
  remote → `--no-ff` merge into the trunk locally, leaving the trunk
  checked out for the next session. A remote → push, then open the MR: via
  `glab mr create` when glab is logged in, else GitLab push options
  (`merge_request.create`, no CLI needed, one-line description since push
  options can't hold newlines), via `gh pr create` for GitHub when gh is
  logged in, else push-only plus a link. The description
  (`repo/delivery-text.ts`) never names Riff: a summary written by the local
  Qwen (fallback: the requirements doc's first paragraph + commits), a QA
  results table, and collapsed commits / files / full QA report. The
  trunk is resolved live by `resolveBaseBranch`: `main` if it exists
  locally or on a remote, else `master`, else the app's stored base
  branch. git/gh run with prompts disabled, so missing credentials fail
  fast instead of hanging.
- No cross-app anything — each session belongs to exactly one app, and
  nothing (docs search, git operations, artifacts) ever spans two apps in
  the same operation. Multi-app support (step 7) is about *which single
  app* a session targets, not about combining apps.
