# Design

Three pieces, one direction of dependency: **workflow JSON → engine → steps**. The robot is a
transport around the engine; the CLI is a view over it.

```
workflow.json ──► parseWorkflow ──► validateWorkflow ──► Engine.run ──► RunResult
                                                            │
                            ┌───────────────────────────────┼──────────────────────────────┐
                            ▼                               ▼                              ▼
                    targeting (uia / fuzzy /        control / api /              desktop seam (nut.js /
                    image / anchor / idx)           ai-vision / ocr              robot.js / OS tools)
                            │                               │                              │
                     element dump (UIA)                    └── office / queue / file ─────┘
                     or the backend's image search
```

The folders mirror that direction: `src/workflow/` is the format (model, target spec, selector
chains), `src/engine/` executes it (engine, targeting, and the store its steps read and write),
`src/project/` holds what a project is made of (templates, packages, the legacy importer),
`src/services/` the steps that need something outside Node — `desktop/` being the backend seam —
and `src/ui/` + `src/robot/` are the two front ends, with `src/cli.ts` on top of all of them.

## The step model

One shape for every step:

```jsonc
{ "type": "desktop", "action": "click", "target": { … },
  "timeoutMs": 30000, "retry": 2, "retryDelayMs": 500, "continueOnError": false,
  "delayBeforeMs": 0, "delayAfterMs": 300, "saveAs": "whatever" }
```

- `type` picks the engine (`desktop`, `control`, `api`, `ocr`, `ai-vision`, `queue`, `file`, `excel`,
  `word`, `data`, `config`, `mail`, `pdf`, `gsheet`, `hitl`).
- `action` names the activity; aliases fold in (`uiaclick`→`uia`, `presskeys`→`pressKey`,
  `wait`→`delay`, `assign`→`setVar`) so recorded spelling and Aro flow JSON both run.
- The resilience fields are *per step, on every type* — continue-on-error, delay before/after,
  timeout, plus a retry. They live in one wrapper (`Engine.runStep`), so no activity can forget them.
- `saveAs` is how a step hands a value to later steps: `${name}` and `{{name}}` interpolate it.
- `verify` runs after a desktop step: the target must be findable again, which is the difference
  between "the click was sent" and "the application reacted".

Nesting is a property of a container step (`then`/`else`/`steps`), validated recursively to depth 5 —
the same budget Aro's server-side validator enforces, so a definition saved in Aro runs here
unchanged.

## The desktop seam

`src/services/desktop/` owns every OS-level call. Three backends implement one interface
(`move`, `position`, `click`, `doubleClick`, `scroll`, `type`, `pressKey`, `drag`, `clipboardWrite`,
`capture`, `findImage`), each declaring the *capabilities* it has on the host:

- **nut.js** — the Apache-2.0 open lineage of nut.js; mouse, keyboard, capture, clipboard, windows
  and image search.
- **robot.js** — pointer, keyboard and raw pixels, written to a file by this repo's own PNG encoder
  (`png.ts`, ~60 lines over `node:zlib`).
- **OS tools** — `xdotool` on Linux/X11, PowerShell + .NET on Windows, `osascript` + `screencapture`
  on macOS: no addon, no build step, and the only backend a CI container can prove.

Two rules make this safe rather than clever:

1. **Probes run in a child process.** A native addon that reaches X11 can abort the whole process
   before JavaScript sees it (libnut's capture on a Wayland session here dies with XGetImage), so the
   probe spawns `node` once, performs the call the lane depends on, and turns a crash, a signal or a
   non-zero exit into "unavailable, and here is why" — the reason lands in the log and in `rpa doctor`.
2. **Capabilities are proved, not assumed.** A step asks for the capability it needs and is refused by
   name when the chosen backend lacks it. Capture is proved twice over: the tool must be installed and
   must really write a file for a throwaway target (ImageMagick's `import` is installed on this
   project's host and cannot grab the screen at all), so the candidate list is tried and the winner is
   named in the backend's detail line.

Which backend serves a run is a step-level decision (`"backend": "os"`), an environment variable
(`RPA_DESKTOP_BACKEND`), or the automatic order with the rejected ones logged. `rpa doctor
--profile desktop` prints the matrix; `rpa robot` proves the family to the orchestrator.

## Targeting

A desktop target is one of four things, tried in order of confidence:

1. **uia** — accessibility properties (Windows UI Automation): every listed one must match. The
   engine dumps the focused window's controls once per lookup (`ElementRecord[]`) and scores them in
   JavaScript, which is what makes the next two passes possible at all.
2. **fuzzy** — the same properties, scored by Normalised Levenshtein similarity (containment floors
   at 0.9), with `exact` as a hard gate and `threshold` (default 0.7) dropping the weak candidates.
   Top to bottom, left to right orders the survivors, and `idx` picks among them.
3. **image** — a template found by the backend's search, against a confidence threshold.
4. **anchor** — a second target resolved first, then candidates filtered by geometric relation
   (`left`/`right`/`above`/`below`/`near`). Anchors apply to both property passes: a property map that
   matches three controls is exactly when an anchor earns its keep.

A `point` covers the trivial case (the workflow already knows where the thing is), and `idx` applies
wherever candidates come from. Nothing is silent: the log names the method that matched
(`target resolved: uia(automationId="saveBtn") → uia at 812,640 (96x28)`), and a failure names
everything that was tried.

Where a host has no accessibility API (Linux, macOS today) the property passes refuse with that
sentence, and image, OCR and vision targeting are the answer — the same honest refusal the rest of the
toolkit follows. Recorded chains (`<wnd/><ctrl/>`) arrive as this spec: `selector-chain.ts` maps a
chain's attributes onto the properties the accessibility API matches on, keeps the window as `scope`
and the raw chain on the step for the report.

### Healing

Two local passes when every method failed, both evidence-only (no service, no ML):

- `relaxed-fuzzy` — the same properties, re-scored with the `exact` gates dropped, offering the
  properties that actually matched as a paste-back target.
- `resemblance` — the image, retried at a lower threshold (never below 0.45).

`recommend` (default) fails the step but carries the candidate in the log, the error and the run's
`heals`; `auto` continues on it; `off` is the plain failure. Healing is skipped while retries remain
(a retry that is about to re-run the same target is not evidence yet), and a `verify` never heals.

## Engine

- **Variables** are one flat map of strings (objects arrive as JSON text); `interpolate` replaces
  `${name}` / `{{name}}` and blanks unknown names. A step that must not run on a blank value checks
  for it (the robot resolves `${secret.*}` before step 1 and refuses otherwise).
- **Conditions** deliberately stop at `==`, `!=`, `!` and truthiness. There is no `eval`, no
  expression language to secure, and a typo skips a branch instead of executing an injection.
- **Cancellation** is a hook (`isCancelled`) asked before every step: the robot answers it by
  polling the orchestrator, a local run answers "never". The run stops at a step boundary.
- **Evidence**: screenshots land in `runs/<timestamp>/` unless a step names a path (`path` is a
  project-relative folder, created if missing — the shape a ported screenshot step uses); every line of
  the run is in `RunResult.logs`, which the CLI prints (or `--report` writes) and the robot ships to
  Aro in batches of 20 / every 2 seconds.
- **Optional modules** are imported lazily with a message that says what to install
  (`@nut-tree-fork/nut-js`, `robotjs`, `tesseract.js`, `exceljs`, `nodemailer`, `imapflow`). A host
  with no desktop addon still drives the desktop through the OS backend — the same rule that lets
  Aro's robot run on a bare Node.

## Robot (orchestrator protocol)

The robot is deliberately thin, because the control plane already exists (Aro): enrol by name with a
project API key, heartbeat what it *proved* it can do, long-poll a claim, run the definition with the
engine, ship logs, poll for cancellation, finalize the run with its outcome. Every endpoint, header
and body is asserted in `test/robotProtocol.test.ts` against a fake orchestrator, so a change on the
Aro side that breaks the contract fails here first.

Two details worth keeping:

- The machine key is re-minted by the orchestrator on every enrolment; the project API key is used
  once and never stored. Nothing long-lived lives on the robot.
- `proved` ≠ `declared`: the desktop family is proved by a backend answering on the host, and the
  proved set is what the orchestrator routes on — a machine without a display is never handed a
  desktop flow. The families that need nothing installed (`control`, `queue`, `excel`, `file`, `data`,
  `config`, `gsheet`, `hitl`, `word`) are proved by the engine running at all; `mail` and `pdf` are
  proved only where nodemailer/imapflow or the `pdftotext` binary are present.

## Roadmap

Ordered by what a desktop robot notices first. Nothing here is blocked on Aro.

| Gap | Why it is a gap | Where it would land |
|---|---|---|
| Wayland-native input | `xdotool` speaks X11, and libnut dies on a native-addon capture there. `ydotool` needs a daemon and a permission | here: an OS-backend profile for Wayland |
| Element properties off Windows | the accessibility dump is Windows-only; macOS (System Events actions without enumeration) and Linux (AT-SPI over D-Bus) need their own readers | here: two more readers behind the same `ElementRecord` shape |
| A dependency-free image matcher | the default search is nut.js's Jimp-based match; the accelerated one is part of that project's paid tier | here: a typed-array template match over a captured frame |
| More backends where they are stronger | `keysender` (Windows hotkeys and window handles) and `active-win` (window enumeration on all three platforms) are MIT and small | here: two more files behind the seam |
| Window management as a step | focus/restore a window before typing is the most common desktop need; the seam exposes no window calls yet | here: `desktop.window` over whatever backend can enumerate |
| An OS-level recorder | the browser recorder is gone with that lane; a desktop recorder captures a session and emits steps | here: a separate program (out of the CLI) |
| Queues in Aro | `queue.*` is local (dispatcher and performer share a folder); Aro has a work-queue store but no robot-facing claim/status API yet | **Aro** (control plane): claim + status per item |
| Schedules/triggers for flows | Aro schedules exist for test runs, not flows yet | **Aro** |
| Document Understanding | open: needs trained models; OCR + regex (and `ai-vision.decide`) is the substitute | out of scope |
| Coded workflows (C#) | A code-first authoring mode | not planned — the engine is Node |

Closed in this pass: the desktop seam itself, the child-process probes, desktop targeting and healing,
`desktop.screenshot` writing where a step says, and the legacy importer landing element activities on
`desktop.uia`. The Studio (`rpa ui`) is a thin client over the same server: the canvas and palette edit
the workflow, the console renders the run's own log lines (structured fields included), the queue tab
adds items and sets a status, and the Human tab lists and answers pending `hitl.ask` requests. A native
shell (Electron/Tauri) would only wrap it, and the local web UI already runs on Windows, Linux and
macOS without one.

## Importing a legacy export

`src/project/import.ts` reads a legacy desktop-automation export (XAML, or a project descriptor listing
XAML files) and writes this tool's JSON plus a `PORTING-REPORT.md`. It is a converter at the edge, not a
second runtime: the engine only ever executes JSON, and a converted file is an ordinary workflow —
`rpa run`, `rpa ui` and a dispatched flow treat it like anything else.

- The XML reader is ~90 lines of this repo (no dependency), namespaces are ignored (local names
  decide), and every node keeps its source line so the report can point at it.
- The activity mapping is a table in that file; an activity with no equivalent is reported, but its
  body is still walked, so a scope this tool does not model never costs the steps written inside it.
- `Click`/`TypeInto`/`GetText` become `desktop.uia` steps, found by the properties their recorded
  chain names (`id` → `automationId`, `aaname`/`name` → `name`, `tag`/`role` → `controlType`), with the
  raw chain kept on the step's target so nothing the record captured is thrown away.
- Expressions are translated only where the meaning is unambiguous. Anything else is reported rather
  than guessed — a silent guess is a workflow that passes for the wrong reason.

## Testing strategy

- `test/desktop.test.ts` — the seam (a backend is chosen, and the others explain themselves),
  capability refusals, the three per-OS command shapes (Windows PowerShell, macOS AppleScript, Linux
  xdotool — asserted from any host, because a command is a string), the PNG writer's bytes, and real
  I/O where a display answers: read the pointer, move it back, capture and check the file.
- `test/unit.test.ts` — targeting maths, model/validator, interpolation, control flow, resilience.
  No display, no network beyond a stubbed `fetch`.
- `test/steps.test.ts` — the queue lifecycle, files, tables/settings, try/catch classification,
  retryScope, invoke and arithmetic/comparisons.
- `test/transaction-loop.test.ts` — the scaffolded template end to end: business exception is terminal,
  application exception retries exactly `MaxRetryNumber` times.
- `test/selector-chain.test.ts` — a recorded chain becomes element properties plus its window scope;
  entry-point arguments; `verify` validation; the orchestrator-shaped queue fields.
- `test/import.test.ts` — a synthetic dispatcher/performer pair converted and run against the queue,
  plus the porting report's unmapped lines.
- `test/ui.e2e.test.ts` — the Studio's HTTP surface plus the page in a real browser (add an activity,
  click Run, watch the console).
- `test/robotProtocol.test.ts` — a fake orchestrator that records every call and asserts the
  protocol: enrol, heartbeat, claim, logs, cancel, finalize — including the failure path.

Runners: the suites import `test` from `node:test` and nothing else, so every suite except the two
browser-driving ones runs unchanged under Jest (`jest.config.mjs`) and Vitest (`vitest.config.ts`) as
well — each maps the `node:test` specifier to a shim in `test/support/` that speaks the runner's own
API and keeps the skip reason. Only the browser suites are pinned to `npm test`, which is where
chromium is guaranteed.
