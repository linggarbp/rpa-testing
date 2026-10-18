# Companion tools — findings

What the companion installers of a commercial RPA suite actually do, read **statically**, and what
this project adopted from them. Product names are deliberately omitted. Nothing is copied — no
code, no assets, no strings; every entry below is a behavior observed in a shipped binary, listed
with the artifact's sha256 so the observation can be re-checked. This repo stays original work (see
the README's closing note).

| artifact (descriptor) | sha256 (prefix) | what it is |
|---|---|---|
| element-inspector package 26.10.x | `1c4953504661…` | the attach/inspect tool + the automation core + the browser driver |
| diagnostics tool package | `9f13b7068d15…` | support tool: collectors, profiles, collect-and-zip |
| browser migration tool | `d26231f7764d…` | rewrites legacy selectors/browser scopes into the modern form |
| project upgrade CLI | `7123786bd1b4…` | project/schema upgrade toolchain (headless Studio assemblies) |
| remote-session runtime MSI | `6a3b8539213c…` | helper that runs inside a remote session and bridges UI trees |
| task-recorder installer | `bf8afb6d2196…` | Electron recorder: global input hooks + per-step screenshots |
| platform installer | `127856af155d…` | the updater (fetches Studio/Assistant; not the products themselves) |

Method: read-only static inspection (`rea inspect-managed-artifact` / `inspect-managed-members`,
plus targeted string-literal scans) of the extracted payloads and of the on-disk installs, plus the
package feed's activity documentation, plus REA's JavaScript application analysis for the Electron
recorder. The Windows install was read in place and never written to. The wall-to-wall pass (every
extracted family, including the installed Studio and the orchestrator payload's assembly band):
**2 636 files read, 2 045 managed assemblies (924 distinct names), 591 native or not managed** —
orchestrator, Studio, updater, robot, action-center payloads among them. Scale worth noting: the
automation core's browser-driver assembly alone declares 1 922 types / 10 520 methods, and the
selector/healing engine assembly (26.10.5 line) declares 4 101 types / 30 819 methods;
the design side ships a dedicated package for recovery configuration (25.10.x line).

## Adopted: target healing (`heal`)

Observed model in the automation core:

- a per-activity recovery behaviour with **four states**: disabled, recommendation-only,
  inherit-from-invocation, as-configured-for-the-job (governance can also disable it entirely);
- recovery is **skipped when the failure is already handled** — inside a try/catch for that
  exception, and inside a retry scope;
- when recovery runs it either reports a recommendation or self-heals and continues; when nothing
  similar exists the log says so ("no heals available") instead of pretending.

Adopted in this repo's own vocabulary, as `heal: off | recommend | auto` on a **target**, a
**step**, or the whole run (`--heal`):

- `recommend` (default) — the step fails exactly as before, but one local healing pass runs and the
  candidate it found is logged and appended to the error;
- `auto` — the step continues on the healed element; the log line and the run's `heals` record say
  from which target to which;
- skipped while retries remain (the retry has not happened yet) — the same "handled elsewhere" rule;
- checks never heal (`waitForElement`, `elementExists`, `verify`): a healed check would lie.

The healing pass itself is local and evidence-only — `relaxed-fuzzy` re-scores the declared
attributes with the hard gates dropped; `resemblance` re-searches by hints read out of the selector
(id / name / class / `[attr=v]` / text). Same similarity function fuzzy matching already uses; no
service, no ML. Code: `src/engine/targeting.ts`, `src/engine/engine.ts`. Tests: `test/heal.test.ts`.

## Adopted: `rpa doctor` diagnostics

Observed model in the diagnostics tool: a run of **collectors** (environment variables, event logs,
log files, registry, computer info), a **profile picker** ("select a diagnostic profile matching
your issue"), per-collector selection before export, and a collect-and-zip action.

Adopted as `rpa doctor`:

- collectors: `runtime`, `dependencies` (which optional modules unlock which capability), `desktop`
  (which backend answered, and the reason each other one did not — see docs/desktop-backends.md),
  `session` (display/wayland, macOS permissions note), `tools` (pdftotext, PowerShell), `project`
  (workflow validation + writability);
- profiles: `default | desktop | robot` select the set;
- `--out report.zip` writes a one-entry archive (our own zip code, `src/project/pack.ts`); `--out *.json`
  writes it plain; `--json` prints it.

Cross-platform by construction: platform differences appear as facts in the report, never as
crashes. Code: `src/services/doctor.ts`. Tests: `test/doctor.test.ts`.

## Adopted, then dropped with its lane: the page recorder

Observed model (REA's JavaScript application graph over the recorder's Electron app — evidence
`ev_08052d0d…`: 541 parsed files, 146 424 AST nodes, 5 170 findings, 540 modules; boundary summary:
8 browser windows, 4 preload entry points, 64 main IPC handlers, 31 paired renderer transmissions,
1 resolved native addon; the graph itself states its truncation limits):

- a **unified recorder** with a driver abstraction (`unified-recorder/contracts`: rec-operation,
  selectorInfo, selectorValidationResult, extensionType, windowType) over per-OS capture;
- an **event-filter layer** (`filters/`: double-click, keyboard-event, mouse-documentation,
  window-handle, allow/deny) deciding what becomes a step;
- a **trigger manager** (hotkey start/stop) and per-step media (`screenshot.js`);
- **two processors over one capture**: documentation output vs RPA output;
- output mappers: Workflow-file export, Word/HTML/CSV exporters, and a document format with explicit
  version upgrades.

Adopted as `rpa record` (page only, deliberately small), and **removed again** when this toolkit
became desktop-only — the code went with the lane rather than sitting unused. What the analysis is
still good for is the OS-level recorder on the roadmap (`docs/design.md`), where the same filter
instincts apply and the capture comes from the desktop instead of the DOM:

- captures click / text input / select change / navigation from the page itself;
- the same filter instincts: double-clicks collapse, our own overlay and an `ignoreSelectors` list
  never become steps, bare body clicks are dropped;
- typing merges per field keeping the step's first position, with the latest value;
- targets follow the anchor order the engine resolves: unique id → unique name → positional path,
  plus the fuzzy spec (and a short-text hint) always, so healing has something to work with;
- the draft is validated before it is written; stop is an overlay button, with a deadline.

Not adopted (yet): global OS input hooks (a different program), per-step screenshots, the document
exporters, the Workflow-file (XAML) mapper, allow/deny lists, hotkey triggers.

## Seen, deliberately not adopted (candidate work)

- **Recorder parts not ported** — per-step screenshots, document exporters (Word/HTML/CSV), the
  workflow-file mapper the recorder uses for its export, allow/deny lists, hotkey triggers (see the
  adopted section above for what `rpa record` took and left).
- **Trigger subsystem** — file-change, queue, time and process triggers with a scope wrapper.
  Would map onto a `rpa watch` mode; bigger than one branch.
- **Storage buckets** — orchestrator-side file storage (upload/download/list/read/write text).
  Belongs with the orchestrator half (Aro), not the engine.
- **Remote-session bridge** — virtual-channel helpers for Citrix/RDP-style sessions. Windows-only
  and outside a cross-platform engine.
- **Attended tray** — the desktop tray app is Electron; its UX is a shell around what `rpa robot`
  already does.
- **Queue lifecycle extras** — postpone-with-due-date, per-item progress, wait-for-new-item are in
  the same family as our `queue.*`; natural follow-ups.
- **Selector migration** — the migration tool rewrites legacy selector arguments into modern ones.
  Reading the legacy form already works (`src/workflow/selector-chain.ts`); an author-time converter
  (`rpa upgrade`) is the follow-up.
- **Web-driver selector engine** — the browser driver delegates fuzzy scoring to its content script:
  `max(0.999 × LevenshteinRatio, 0.95 × TokenSortRatio)` compared against a `fuzzyLevel`, with a
  `matchingType` switch picking exact/full/fuzzy matchers, plus per-framework table-row shortcuts
  (`ui5-tableRow`, `aw-tablerow`, `sapweb-tablerow`). Our engine's `similarity()` stays its own, but
  token-sort scoring is a candidate upgrade if fuzzy misses show up in practice.
- **Activity catalog gaps** — the System activity docs (159 entries) list data-table ops, collection
  ops, date/text helpers, `InvokeProcess`, timers and more that this engine does not have yet (the
  engine ships 69 actions across 15 types; healing and doctor are this branch's additions).
