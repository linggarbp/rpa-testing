# nutjs-testing

[![CI](https://github.com/linggarbp/rpa-testing/actions/workflows/ci.yml/badge.svg)](https://github.com/linggarbp/rpa-testing/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Desktop automation for Node, in one toolkit: a JSON workflow format, an engine that drives the real
screen, a Studio that runs in your browser, and a robot client. The **orchestrator** half is
[Aro](../../aro-project): robots, flow definitions, dispatch, run logs and the asset vault already
live there, and this project's robot speaks Aro's protocol unchanged.

```
nutjs-testing (this repo)                   Aro (orchestrator)
  ├─ workflow format  (JSON)                  ├─ robot registry + pools
  ├─ engine           (desktop / office /     ├─ flow definitions + designer
  │                    ocr / vision)          ├─ dispatch (claim → run → finalize)
  ├─ targeting        (uia / fuzzy / image /  ├─ run logs + run history
  │                    anchor / idx)          ├─ asset vault (${secret.*})
  ├─ backends         (nut.js / robot.js /    └─ AI endpoint per project
  │                    the OS tools)
  ├─ CLI              (run / validate / init /
  │                    doctor / robot)
  └─ robot client     ──────────────────────►
```

Author and debug locally with `rpa run`, then let Aro dispatch the *same* JSON to a machine with
`rpa robot`. There is no second dialect to keep in sync.

**Why desktop, and why this name.** The Node desktop-automation ecosystem collapsed into one
library: nut.js, whose public packages were pulled from npm and whose author now sells the same
capability as a subscription (the desktop line's own repository has been quiet since May 2024). The
surviving open fork is Apache-2.0, frozen in March 2025, and still pulled ~195k times a month. This
toolkit is built on that open lineage — as one of three backends behind a seam this repo owns — so
the desktop lane has a maintained home instead of a paid one. See
[docs/desktop-backends.md](docs/desktop-backends.md) for what each backend proves where.

## Quick start

```bash
git clone <this repo> nutjs-testing && cd nutjs-testing
npm install                              # nut.js is an optional dependency; the seam works without it

npm run rpa -- ui                        # Studio: opens http://127.0.0.1:4319 in your browser
npm run rpa -- activities                # what this tool can do
npm run rpa -- doctor --profile desktop   # which backends answer on this machine, and why
npm run rpa -- init demo --template transactional
npm run rpa -- run demo/Main.json
```

`rpa ui` is the whole Studio: canvas + activity palette + properties + live console + queue tab (add
items, set a status) + a Human tab for pending `hitl.ask` questions. It works the same on Windows,
Linux and macOS (`--no-open` on a headless host, `--port N` to move it). There is no bundler, no
Electron and no build step — the page is three static files in `ui/`.

Run a workflow as a robot for an Aro orchestrator:

```bash
# Project → API Key (Aro), then:
npm run rpa -- robot --api https://<aro> --project <projectId> --api-key <project API key>
# check without leaving anything behind:
npm run rpa -- robot --api https://<aro> --project <projectId> --api-key <key> --once --json
```

The robot appears under **Orchestrator → RPA → Robots** in Aro within ~20 seconds and is
dispatchable from there.

## Platforms

Runtime floor: **Node ≥ 22.19** (`engines`), tracking latest stable — TypeScript 7, tsx 4, Node 24
in CI.

Desktop steps go through the first backend that **proves** itself on the host:

| backend | Windows | Linux | macOS | gives |
|---|---|---|---|---|
| **nut.js** (default) | ✅ prebuilt | ⚠️ X11; a Wayland session answers a size query and then dies on capture (`X_GetImage`) | ✅ with Accessibility + Screen Recording granted | mouse, keyboard, capture, clipboard, windows, image search |
| **robot.js** (fallback) | ✅ prebuilt | ✅ prebuilt | ✅ prebuilt | mouse, keyboard, capture (raw pixels through this repo's own PNG writer) |
| **OS tools** | ✅ PowerShell + .NET | ✅ xdotool + a capture tool proved to work | ⚠️ click/type/clipboard/capture only | no addon, no build step; the only backend CI can prove |

The families that need nothing installed (`control`, `queue`, `excel`, `file`, `data`, `config`,
`gsheet`, `hitl`, `word`) are proved by the engine itself; `mail` and `pdf` are proved only where
nodemailer/imapflow or the `pdftotext` binary exist. `rpa robot` reports the proved set to the
orchestrator, so a machine with no display is never handed a desktop flow — `rpa robot --once` prints
the declared/proved pair.

## Activities

```
desktop    move click doubleClick rightClick type scroll pressKey drag clipboardCopy
           screenshot waitForImage clickImage uia        (uia = PowerShell UI Automation, Windows)
control    delay setVar math log if switch repeat while foreach try throw retryScope invoke stateMachine
queue      addItem getTransactionItem setStatus count list  (local queue, dispatcher/performer semantics)
file       forEachFile move readText writeText exists delete mkdir
excel      readRange writeRange writeCell forEachRow        (CSV native, XLSX via exceljs)
word       readText writeText                               (.docx over the stdlib zip + XML)
data       jsonParse regexMatches
config     load                                             (JSON/CSV/XLSX → ${Config.*})
mail       send receive                                     (SMTP via nodemailer, IMAP via imapflow)
pdf        readText                                         (native text via pdftotext)
gsheet     append read                                      (Google Sheets v4 REST)
hitl       ask                                              (file-based prompt; `rpa hitl answer`)
api        request                                          (integration calls beside the desktop work)
ocr        recognize                                        (tesseract.js, wasm)
ai-vision  decide                                           (desktop screenshot → project's endpoint → one action)
```

Every step also accepts `timeoutMs`, `retry`, `retryDelayMs`, `continueOnError`, `delayBeforeMs`,
`delayAfterMs` and (for reads) `saveAs`. `control.log` takes `fields`, a map interpolated onto the
log line and shipped to the orchestrator in the same batch:

```jsonc
{ "type": "control", "action": "log", "message": "processing ${TransactionItem.id}",
  "fields": { "process": "${Config.ProcessName}", "transaction": "${TransactionItem.id}" } }
```

prints `[info] {process=Invoice, transaction=tx-1} processing tx-1`.

### Targeting

A target names the thing a step acts on, and it is one of four shapes plus a point:

```jsonc
{
  "type": "desktop", "action": "click",
  "target": {
    // 1. accessibility properties — every listed one must match
    "uia": { "automationId": "saveBtn", "name": "Save", "controlType": "Button" },
    // 2. the same properties, scored ('exact' is still a hard gate)
    "fuzzy": { "properties": { "name": "Save" }, "levels": { "name": "fuzzy" }, "threshold": 0.8 },
    // 3. an image found on screen
    "image": { "path": "assets/save.png", "threshold": 0.9 },
    // 4. an anchor: a second element that disambiguates by geometry
    "anchor": { "target": { "fuzzy": { "properties": { "name": "File" } } }, "relation": "right" },
    "idx": 1
  }
}
```

A recorded chain (`<wnd app='notepad.exe' title='…' /><ctrl id='textBox1' name='Text editor' />`)
becomes exactly that spec: the element's properties plus the window it came from as `scope`, and the
chain itself is kept on the step so a report shows what was recorded. Property lookups read the
focused window's controls (Windows UI Automation) and score them in JavaScript; where a host has no
such API (Linux, macOS today) the pass refuses with the sentence that says so, and image/OCR/vision
targeting is the answer there. The log says which method matched:

```
[info] target: uia: 1 element(s) match uia(automationId="saveBtn")
[info] target resolved: uia(automationId="saveBtn") → uia at 812,640 (96x28)
```

For `clickImage` / `waitForImage` the step form is unchanged — `{ "imagePath": "assets/save.png",
"confidence": 0.9 }` — and it also works with an `image` target.

### Healing — what a failed target may recover to

When every declared method failed, two local passes run before the step gives up: `relaxed-fuzzy`
re-scores the same properties with the hard gates dropped, and `resemblance` retries the image at a
lower threshold. Three modes, set on a target, on a step, or for the whole run (`rpa run --heal …`):

| mode | what a failed target does |
|---|---|
| `recommend` *(default)* | fails as before, but the log and the error carry the candidate it found |
| `auto` | continues on the healed element; the log and the run's `heals` say what changed |
| `off` | the plain failure |

```jsonc
{ "type": "desktop", "action": "click",
  "target": { "uia": { "automationId": "save-v2" }, "heal": "auto", "healThreshold": 0.75 } }
```

```
[warn] target healed (relaxed-fuzzy, 0.86): fuzzy(name~"Save") (0.86)
```

Healing is evidence-only (the same similarity function fuzzy matching uses — no service, no ML) and
it knows when not to run: it is skipped while retries remain, and a `verify` never heals — a healed
check would lie. `--heal` on a run is a cap, so `--heal off` is the plain-failure switch, and
`--heal recommend` previews what `auto` would have done. Every heal lands in the `--report` file
under `heals`, applied or merely suggested.

### Verifying that the application reacted

`verify` waits for the target to be findable again after the action — the check that the app moved,
not merely that the click was sent:

```jsonc
{ "type": "desktop", "action": "click",
  "target": { "uia": { "name": "Save" } },
  "verify": { "target": { "uia": { "name": "Saved" } }, "timeoutMs": 5000 } }
```

## Transactional loop template

`rpa init <dir> --template transactional` scaffolds a transactional automation project: Init → Get
Transaction Data → Process → End Process, split into one file per concern under `Framework/`
(`InitAllSettings`, `InitAllApplications`, `GetTransactionData`, `Process`, `SetTransactionStatus`,
`RetryCurrentTransaction`, `TakeScreenshot`, `KillAllProcesses`, `CloseAllApplications`). Settings
come from `config.json`, work items from the local queue, and a failure is classified **business**
(stop, no retry) or **application** (retry up to `MaxRetryNumber`, then fail the item).

```bash
npm run rpa -- init bot --template transactional
cd bot
npm --prefix .. run rpa -- queue add InvoiceQueue INV-001 '{"amount":"120.00"}'
npm --prefix .. run rpa -- run Main.json
npm --prefix .. run rpa -- queue InvoiceQueue        # Successful / BusinessException / …
```

## Commands

```
rpa run <workflow.json|package.rpapkg>  run it here (--var k=v, --report out.json, --json,
                                        --heal off|recommend|auto)
rpa validate <workflow.json…>  syntax + shape, no execution
rpa import <export.xaml|project.json> --out <dir>   convert a legacy export; writes PORTING-REPORT.md
rpa pack <project> --out <file.rpapkg>  zip a project with a manifest (--entry, --name, --version)
rpa activities                 the catalog above
rpa ui                         Studio in the browser (--project <dir>, --port N, --no-open)
rpa doctor                     check this machine: collectors + profiles (--profile default|desktop|robot,
                               --project <dir>, --out report.zip|report.json, --json)
rpa init <dir>                 scaffold (--template basic|transactional)
rpa queue <name> | add <name> <ref> [json]   the local transaction queue
rpa hitl [answer <id> <value>]  human-in-the-loop questions (hitl.ask waits on these)
rpa robot …                    connect to Aro and take dispatched flows
```

## Packages

`rpa pack <project> --out bot.rpapkg` writes a zip (no dependency — node:zlib) holding the project's
files plus a `manifest.json` with the name, version, entry and a sha256 per file. `rpa run bot.rpapkg`
extracts it to a temporary folder, checks every hash against the manifest, runs the entry there and
cleans up: `invoke`, `config.load`, `file.*`, `excel.*`, `queue.*` resolve inside the package.

```
rpa pack bot --out bot-1.0.rpapkg --version 1.0.0
rpa run bot-1.0.rpapkg --var Out=/tmp/report.txt
```

A file that changed after packing is refused by name (`Main.json does not match the manifest`) — that
is what the hashes are for. There is no signing: the manifest proves a package is intact, not who
built it. Local state (`.rpa/`, `runs/`) is deliberately not packaged.

## Importing a legacy export

`rpa import <file.xaml|project.json> --out <dir>` reads a legacy desktop-automation export and writes
this tool's JSON beside a `PORTING-REPORT.md`. The engine stays JSON — this is a converter at the
edge, not a second runtime.

| Converted | Becomes |
|---|---|
| `Sequence`, `Flowchart`, `StateMachine` | flattened into their steps (a state machine gets a note) |
| `If`, `While`, `ForEach` | `control.if` / `while` / `foreach` |
| `TryCatch` / `Throw` | `control.try` (a business-rule exception type → the `business` catch) |
| `RetryScope`, `Delay`, `Assign`, `MultipleAssign` | `control.retryScope`, `delay`, `setVar`, `math` |
| `LogMessage`, `InvokeWorkflowFile`, `InputDialog` | `control.log`, `invoke`, `hitl.ask` |
| `Click`, `TypeInto`, `GetText` | `desktop.uia` invoke / setValue / getText, found by the properties the recorded chain names |
| `AddQueueItem`, `GetTransactionItem`, `SetTransactionStatus` | `queue.addItem` / `getTransactionItem` / `setStatus` |
| `ReadRange`, `WriteRange`, `WriteCell`, `ForEachRow` | `excel.*` (the loop keeps the sheet it was read from) |
| `ForEachFileX`, `MoveFile`, `ReadPDFText` | `file.forEachFile`, `file.move`, `pdf.readText` |
| `Matches`, `DeserializeJson` | `data.regexMatches`, `data.jsonParse` |

A scope that opens a browser or a window does not open it: the note in the report says so, and the
steps inside run against whatever window has focus. Expressions are translated only where the meaning
is unambiguous (`Config("Queue")` → `${Config.Queue}`, `RetryNumber + 1` → `control.math`); everything
else — an unknown activity, an untranslatable expression — lands in the report with its source line.

## Design notes

| Concern | This tool |
|---|---|
| Authoring | `rpa ui` — canvas, palette, properties, live console, queue tab, Human tab |
| Input | one seam, three backends: nut.js, robot.js, or the OS tools — picked by probing, logged either way |
| Capabilities | declared per backend, proved per host, refused by name when a step needs one that is missing |
| Targeting | uia → fuzzy (scored properties) → image → anchor, `idx` for the nth, with the method logged |
| Recovery | `heal: off/recommend/auto` on a target or step (`--heal` for the run): re-scores locally and reports — or applies — the fix |
| Verification | `verify.target` waits for the application to react, and never heals |
| Diagnostics | `rpa doctor` — collectors (runtime, dependencies, desktop, session, tools, project), profiles, report/zip |
| Step options | `timeoutMs`, `delayBeforeMs`, `delayAfterMs`, `continueOnError`, `retry` |
| Transaction loop | `rpa init --template transactional` — one file per concern, local queue, exception classes |
| Orchestrator | **Aro**: robots, flows, dispatch, logs, assets — this repo is the robot |
| Queues | local `queue.*` with dispatcher/performer semantics (Aro has a work-queue store; a robot-facing claim/status API is the missing half) |
| Credentials | `${secret.NAME}` resolved once before step 1 (Aro's asset vault on a robot) |
| Still open | a macOS/Linux element dump (image + OCR is today's answer there), a dependency-free image matcher, a wider capture-tool list |

## Tests

```bash
npm test             # type-check + unit + desktop I/O + Studio E2E + a fake-Aro protocol suite
npm run test:jest    # every non-e2e suite under Jest
npm run test:vitest  # … and the same set under Vitest
npm run test:runners # both, in that order
npm run test:all     # everything: npm test + the two runners
```

The suites are written once, against `node:test`, and run under three runners: Vitest aliases the
`node:test` specifier to a shim (`test/support/vitest-node-test.ts`), Jest maps it to the same surface
(`test/support/jest-node-test.cjs`), and `node:test`'s `{ skip: reason }` becomes the runner's own skip
so a suite still says why it stepped aside. Scope is every suite except the two browser-driving ones.
Jest runs in ESM mode with Babel stripping types, so neither runner pins a transformer to the
TypeScript version; the type-check is its own step (`npm run test:types`).

The suites: `test/desktop.test.ts` (the seam, the three per-OS command shapes, the PNG writer, and
real pointer + capture I/O), `test/unit.test.ts` (targeting maths, model, control flow, resilience),
`test/steps.test.ts` (queue lifecycle, files, tables, settings, try/catch, retryScope, invoke),
`test/transaction-loop.test.ts` (the scaffolded template: business vs application exception paths),
`test/selector-chain.test.ts` (chain → target, entry-point arguments, verify), `test/pack.test.ts`
(pack → run from the archive; a tampered file refused), `test/import.test.ts` (a synthetic
dispatcher/performer pair imported and run against the queue; the porting report), `test/doctor.test.ts`
(collector shape, profiles, project validation, the report zip), `test/word.test.ts` (write → read
round-trip; a foreign docx reads; LibreOffice opens what we wrote), `test/gaps.test.ts` (mail, PDF,
Sheets, HITL, state machine, UIA), `test/ui.e2e.test.ts` (the Studio's API — including the Human tab
answering a waiting `hitl.ask` — and the page driven in a real browser), `test/robotProtocol.test.ts`
(enrol/heartbeat/claim/logs/cancel/finalize against a fake orchestrator, including a dispatched
`queue.addItem` flow asserted on the queue file it wrote).

### Verified

- `npm test` — **97/97**, 0 skipped: type-check + unit + desktop I/O + the Studio in a real browser +
  a fake-orchestrator protocol suite. `npm run test:jest` — 11 suites, **90/90**; `npm run test:vitest`
  — 11 files, **90/90**.
- Desktop lane proved on this host (Linux/Wayland, 2026-10-18): the seam reported
  `desktop backend: os — xdotool on Linux/X11 — capture via spectacle`, and skipped the other two with
  their reasons (`nut.js refused this display: X Error of failed request: BadMatch (invalid parameter
  attributes)`, `robotjs is not installed`). A workflow with `desktop.screenshot` wrote a real
  **2880×1800 PNG, 608,723 bytes** in 790 ms, and the run passed. The test suite does the same thing
  without hijacking the mouse: it reads the pointer, moves it back where it was, captures the screen
  and checks the PNG signature and size. CI runs the suite under `xvfb-run`, so the Linux lane is
  proved on every push.
- Windows and macOS command shapes are asserted from Linux in `test/desktop.test.ts` (PowerShell
  `mouse_event` flags and SendKeys escaping; AppleScript `click at {x, y}`, `keystroke … using
  {command down}`, key codes, `pbcopy`, `screencapture`) — a string is a string, so a mistake in the
  other two platforms' input paths fails CI here rather than on a user's machine. What is *not*
  claimed: no Windows or macOS host was driven for real in this run.
- Two bugs the tests caught, worth naming: the Windows horizontal-wheel delta had the sign the wrong
  way round (`right` scrolled left), and ImageMagick's `import -window root` is installed on this host
  and cannot grab the screen at all — which is why capture is proved at probe time and tried through a
  candidate list (spectacle and ffmpeg's x11grab both work).
- Legacy import exercised against a synthetic dispatcher/performer pair whose recorded chains land on
  `desktop.uia` steps, then run against the queue; mail against a real SMTP server; PDF text against a
  generated invoice; a package against a tampered archive; `word.*` round-tripped and re-opened by
  LibreOffice.

## Layout

```
src/cli.ts             run / validate / activities / ui / doctor / init / queue / hitl / pack / robot
src/workflow/          the format: what a workflow is, and how a target is named
  model.ts             workflow + step model, validation, action aliases, the desktop target spec
  selector-chain.ts    recorded chain (`<wnd/><ctrl/>`) → element properties + window scope
src/engine/            executing one: the runtime, and how a step finds its thing
  engine.ts            step execution, resilience, variables, logging, verify, heal reporting
  targeting.ts         uia / fuzzy / image / anchor resolution + the two healing passes
  store.ts             local queue, settings (JSON/CSV/XLSX), files, tables
  word.ts              .docx read/write (the zip codec comes from project/pack.ts)
src/project/           the files a project is made of
  templates.ts         project templates (basic, transactional)
  pack.ts              the package format (zip + manifest, node:zlib)
  import.ts            the legacy-export importer (XAML → JSON + PORTING-REPORT.md)
src/services/          the parts that reach outside the process
  desktop/             the backend seam
    backend.ts         capability model, child-process probes, backend choice + report
    nutjs.ts           the nut.js backend (mouse, keyboard, screen, clipboard, images)
    robotjs.ts         the robot.js fallback (pointer, keyboard, pixels)
    os.ts              the OS tools: xdotool / PowerShell / osascript, per-OS profiles
    png.ts             a PNG writer over node:zlib (raw pixels → a file)
  gaps.ts              mail, PDF, Google Sheets, HITL, Windows UIA (+ the element dump)
  doctor.ts            environment diagnostics: collectors, profiles, report / zip
src/ui/server.ts       the Studio: API + SSE run stream + the static page
src/robot/aro.ts       the orchestrator protocol (robot side)
ui/                    the Studio page (index.html, app.js, style.css) — no build step
test/support/          the shims that let one suite run under node:test, Jest or Vitest
jest.config.mjs        Jest: ESM + Babel type-strip, the non-e2e suite set
vitest.config.ts       Vitest: the same set, `node:test` aliased to the shim
examples/              a desktop workflow and a desktop+OCR workflow
docs/                  design.md, desktop-backends.md, companion-tools.md
```

Personal project. The workflow format, engine, templates and docs here are original work; nut.js is
used through its Apache-2.0 open fork and robot.js through its MIT licence, and no code or
documentation from any commercial RPA product is included.

## License

MIT — see [LICENSE](LICENSE).
