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
   base prompt wholesale. Dependencies are advisory only: each child still
   branches off the app's base branch. Live-verified on a scratch server:
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
    settings.ts             — Provider/Role types, KNOWN_MODELS (curated, not exhaustive — any model ID works), redaction
    settings-store.ts        — reads/writes backend/local-settings.json
    prompts-store.ts          — per-app, per-role system prompt overrides; reads/writes backend/local-prompts.json, seeds the legacy app's overrides from prompts/customer-edi-legacy/*.md the first time it's read
  agents/
    handoff.ts               — the opening note of a new coding conversation (step boundary, QA fix, compaction): repo state + Qwen-written notes on the previous conversation
    sdk-client.ts            — BOTH engines: runAgentTurn() (AI SDK: resolveLanguageModel() switches on ApiKeyProvider, streamText() with stopWhen: stepCountIs(20)) and runClaudeAgentTurn()/testClaudeLogin() (Claude Agent SDK: query(), MCP server, resume: sessionId, cwd: the session's app's repoRoot) — both normalize to the same AgentEvent union so routes/frontend don't care which ran
    requirements-agent.ts, plan-agent.ts, coding-agent.ts, qa-agent.ts — one per role: resolve the session's app, load prompt (app override, else the checked-in base) + role's model config, branch on provider === 'claude' to pick engine + matching tool set (tool-defs/ vs tool-defs-claude/) built against that app's repoRoot, persist transcript + (history or claudeSessionId)
    prompts.ts                — readBasePrompt(role): the checked-in file for a role, or coordinator-agent.ts's DECISION_INSTRUCTIONS constant for "coordinator" (which has no file) — used by the Apps page's "view base prompt"
    prompts/*.md             — app-generic base system prompts (no target-repo specifics)
    prompts/customer-edi-legacy/*.md — verbatim archive of the original Customer-EDI-specific prompt content, seeded as that app's prompt overrides (see prompts-store.ts above)
    tool-defs/*.ts            — one file per tool group; each exports schema + description + a factory (createXExecute(s)/createXTool(s)) that closes over a repoRoot/appId, built fresh per turn by the *-agent.ts files
    tool-defs-claude/*.ts     — same tool groups, Claude-Agent-SDK tool() wrappers around the SAME factory-produced execute functions from tool-defs/ via wrap.ts's wrapForClaudeSdk() — no logic duplicated, only the SDK-format glue
  repo/
    guardrails.ts             — assertPathAllowed(path, allowedRoots, repoRoot), shared path-allowlist used by every general-purpose file tool (not by the dedicated requirements/QA-report writers, which write directly via fs and bypass this)
    git.ts                     — simple-git wrapper, every export takes repoRoot: branch preconditions, commit, diff against master
    docs-index.ts               — hand-rolled keyword search, per app (Map<appId, sections/indexedAt/watcher>) over <app.repoRoot>/docs/**/*.md (no flexsearch — its CJS/no-exports-map shape was an import-interop risk not worth taking; no embeddings — corpus is small)
  routes/                       — one file per resource: sessions, requirements, plan, coding, qa, settings, apps (apps + their prompts/integrations/openapi/handbook), coordinator

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
