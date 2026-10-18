# rpa-testing

[![CI](https://github.com/linggarbp/rpa-testing/actions/workflows/ci.yml/badge.svg)](https://github.com/linggarbp/rpa-testing/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A personal RPA toolkit: a JSON workflow format, a step engine, a Studio that runs in your browser,
and a robot client. The **orchestrator** half is [Aro](../../aro-project): robots, flow definitions,
dispatch, run logs and the asset vault already exist there, and this project's robot speaks Aro's
protocol unchanged.

```
rpa-testing (this repo)                     Aro (orchestrator)
  ├─ workflow format  (JSON)                  ├─ robot registry + pools
  ├─ engine           (web / desktop / api /  ├─ flow definitions + designer
  │                    ocr / ai-vision)       ├─ dispatch (claim → run → finalize)
  ├─ targeting        (strict / fuzzy /       ├─ run logs + run history
  │                    anchor / idx)          ├─ asset vault (${secret.*})
  ├─ CLI              (run / validate /       └─ AI endpoint per project
  │                    pick / init / robot)
  └─ robot client     ──────────────────────►
```

Author and debug locally with `rpa run`, then let Aro dispatch the *same* JSON to a machine with
`rpa robot`. There is no second dialect to keep in sync.

## Quick start

```bash
git clone <this repo> rpa-testing && cd rpa-testing
npm install
npx playwright install chromium          # browsers (web steps)

npm run rpa -- ui                        # Studio: opens http://127.0.0.1:4319 in your browser
npm run rpa -- activities                # what this tool can do
npm run rpa -- init demo --template transactional  # a transactional-loop project
npm run rpa -- run demo/Main.json --headed
npm run rpa -- validate demo/Main.json
```

`rpa ui` is the whole Studio: canvas + activity palette + properties + live console + queue tab
(add items, set a status) + a Human tab for pending `hitl.ask` questions, plus a **Pick element**
button that runs the same code path as `rpa pick` and drops the step onto the canvas. It works the
same on Windows, Linux and macOS (`--no-open` on a headless host, `--port N` to move it). There is no
bundler, no Electron and no build step — the page is three static files in `ui/`.

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

Runtime floor: **Node ≥ 22.19** (`engines`), and the stack tracks latest stable — Playwright 1.64,
TypeScript 7, WebdriverIO 10 (optional, mobile `driver: "webdriverio"`).

Everything the engine does is cross-platform Node; the differences are the ones the OS imposes:

| | Windows | Linux | macOS |
|---|---|---|---|
| Web steps (Playwright) | ✅ | ✅ (headless by default) | ✅ |
| Desktop steps (nut.js) | ✅ | ✅ X11; Wayland partial; headless needs `xvfb-run` | ✅ **needs Accessibility + Screen Recording** granted to the terminal/app |
| OCR (tesseract.js, wasm) | ✅ | ✅ | ✅ |
| Robot mode | ✅ | ✅ | ✅ |
| Native libs for desktop steps | none | `libxtst6 libpng16-16 libxkbcommon0` (+ `xvfb`) | none extra |

Capabilities are *proved*, not claimed: `rpa robot` probes which modules actually load and reports
that set to the orchestrator, so a machine without a desktop module is never handed a desktop flow.
The engine families (`queue`, `excel`, `file`, `data`, `config`, `gsheet`, `hitl`) are proved by the
engine itself — they need nothing installed — while `mail` and `pdf` are proved only where
nodemailer/imapflow or the `pdftotext` binary are present. A robot therefore declares all twelve
families by default and the orchestrator routes on what it proved, so a flow it cannot run is refused
at dispatch instead of failing mid-run. `rpa robot --once` prints the declared/proved pair.

## Activities

```
web        goto click type hover selectOption getText getAttribute elementExists
           waitForElement pressKeys scroll screenshot assertText extractTable
control    delay setVar math log if switch repeat while foreach try throw retryScope invoke stateMachine
queue      addItem getTransactionItem setStatus count list        (local queue, dispatcher/performer semantics)
excel      readRange writeRange writeCell forEachRow              (CSV native, XLSX via exceljs)
file       forEachFile move readText writeText exists delete mkdir
data       jsonParse regexMatches
config     load                                                   (JSON/CSV/XLSX → ${Config.*})
mail       send receive                                           (SMTP via nodemailer, IMAP via imapflow)
pdf        readText                                               (native text via pdftotext)
gsheet     append read                                            (Google Sheets v4 REST)
hitl       ask                                                    (file-based prompt; `rpa hitl answer`)
api        request load
mobile     session end tap type getText waitFor swipe screenshot    (WebDriver — driver: raw (W3C,
                                                                    default, zero-dep) | webdriverio;
                                                                    Appium & Selenium answer both)
word       readText writeText                                      (.docx over the stdlib zip + XML)
desktop    move click doubleClick rightClick type scroll pressKey drag clipboardCopy
           screenshot waitForImage clickImage uia                 (uia = PowerShell UI Automation, Windows)
ocr        recognize
ai-vision  decide                      (project's own OpenAI-compatible endpoint; key travels with the job)
```

Every step also accepts `timeoutMs`, `retry`, `retryDelayMs`, `continueOnError`, `delayBeforeMs`,
`delayAfterMs` and (for reads) `saveAs`.

`web.extractTable` reads a whole table in one round-trip — `{ "table": "#orders", "headerRow": true,
"saveAs": "rows" }` stores header-keyed rows, sets `${rows.count}`, and fails naming the selector when
no table matches.

`control.log` takes `fields`, a map interpolated onto the log line and shipped to the orchestrator in
the same batch:

```jsonc
{ "type": "control", "action": "log", "message": "processing ${TransactionItem.id}",
  "fields": { "process": "${Config.ProcessName}", "transaction": "${TransactionItem.id}" } }
```

prints `[info] {process=Invoice, transaction=tx-1} processing tx-1`.

`api.load` is a load check that lives *inside* a workflow — VUs × iterations (a duration also caps
it), latency percentiles and an error rate, no external tool in the loop:

```jsonc
{ "type": "api", "action": "load", "url": "https://api.example/health",
  "vus": 4, "iterations": 40, "expectStatus": 200, "saveAs": "load" }
```

```
[info] api.load GET https://api.example/health → 40 request(s) in 129 ms (310.1 rps), p50 11 ms, p95 18 ms, 0 error(s)
```

The same 4×40 against the same endpoint with **k6**: 369 rps, p95 13.8 ms — the difference is
fetch overhead, and the point is that the numbers sit in the flow next to the steps they protect.
A non-2xx does not throw here: it is counted, because that is the measurement.

### Targeting

```jsonc
{
  "type": "web", "action": "click",
  "target": {
    // 1. strict selector, with fallbacks tried in order
    "strict": "#submit",
    "strictAny": ["button[type=submit]", "text=Sign in"],
    // 2. fuzzy: tag + attribute values scored against a threshold ('exact' is a hard gate)
    "fuzzy": { "tag": "BUTTON", "attributes": { "aaname": "Sign in" },
               "levels": { "aaname": "fuzzy" }, "threshold": 0.8 },
    // 3. anchor: a second element that disambiguates by geometry
    "anchor": { "target": { "strict": "label[for=password]" }, "relation": "below" },
    // 4. 1-based occurrence
    "idx": 1
  }
}
```

The log says which method actually matched (`target found by fuzzy selector (score 0.91, 3
match(es))`), so a run that survived a changed page says so instead of pretending nothing moved.

### Healing — what a failed target may recover to

When every declared method failed, one more **local** pass runs before the step gives up: it
re-scores the page with the hard gates relaxed (`relaxed-fuzzy`) and re-searches by the selector's
own hints — id, name, class, `[attr=v]`, text (`resemblance`). Three modes, set on a target, on a
step, or for the whole run (`rpa run --heal …`):

| mode | what a failed target does |
|---|---|
| `recommend` *(default)* | fails as before, but the log and the error carry the candidate it found |
| `auto` | continues on the healed element; the log and the run's `heals` say what changed |
| `off` | the plain failure |

```jsonc
{ "type": "web", "action": "click",
  "target": { "strict": "#save-v2", "heal": "auto", "healThreshold": 0.75 } }
```

```
[warn] target healed after every method failed — resemblance: id 'save-v2' ≈ 'save-v3' (score 0.86) → {"strict":"#save-v3"}
```

Healing is evidence-only (the same similarity function fuzzy matching uses — no service, no ML) and
it knows when not to run: it is skipped while retries remain, and it never applies to checks
(`waitForElement`, `elementExists`, `verify`) — a healed check would lie. `--heal` on a run is a cap:
a step may ask for less than it allows, never more — so `--heal off` is the plain-failure switch,
and `--heal recommend` previews what `auto` would have done. Every heal lands in the `--report` file
under `heals`, applied or merely suggested.

`rpa pick <url>` opens a browser, lets you click an element, and prints the target JSON to paste in
— the "indicate element" workflow, without a designer. The Studio's **Pick element** button calls the
same code (`src/ui/pick.ts`, `POST /api/pick { url }`) and appends the step where the canvas is pointing.

## Transactional loop template

`rpa init <dir> --template transactional` scaffolds a transactional automation project: Init → Get
Transaction Data → Process → End Process, split into one file per concern under `Framework/`
(`InitAllSettings`, `InitAllApplications`, `GetTransactionData`, `Process`, `SetTransactionStatus`,
`RetryCurrentTransaction`, `TakeScreenshot`, `KillAllProcesses`, `CloseAllApplications`). Settings come
from `config.json`, work items from the local queue, and a failure is classified **business** (stop,
no retry) or **application** (retry up to `MaxRetryNumber`, then fail the item).

```bash
npm run rpa -- init bot --template transactional
cd bot
npm --prefix .. run rpa -- queue add InvoiceQueue INV-001 '{"amount":"120.00"}'
npm --prefix .. run rpa -- run Main.json
npm --prefix .. run rpa -- queue InvoiceQueue        # Successful / BusinessException / …
```

## Commands

```
rpa run <workflow.json|package.rpapkg>  run it here (--headed, --var k=v, --report out.json, --json, --heal off|recommend|auto)
rpa validate <workflow.json…>  syntax + shape, no execution
rpa import <export.xaml|project.json> --out <dir>   convert a legacy export; writes PORTING-REPORT.md
rpa pack <project> --out <file.rpapkg>  zip a project with a manifest (--entry, --name, --version)
rpa activities                 the catalog above
rpa ui                         Studio in the browser (--project <dir>, --port N, --no-open)
rpa pick <url>                 click an element, get its target JSON (--out target.json)
rpa record <url>               record a browser session into a draft workflow (--out draft.json,
                               --max-seconds N, --headless)
rpa doctor                     check this machine: collectors + profiles (--profile default|robot|web,
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

```bash
rpa import LegacyBot/project.json --out bot
cd bot && npm --prefix .. run rpa -- run Dispatcher.json
```

| Converted | Becomes |
|---|---|
| `Sequence`, `Flowchart`, `StateMachine` | flattened into their steps (a state machine gets a note) |
| `If`, `While`, `ForEach` | `control.if` / `while` / `foreach` |
| `TryCatch` / `Throw` | `control.try` (a business-rule exception type → the `business` catch) |
| `RetryScope`, `Delay`, `Assign`, `MultipleAssign` | `control.retryScope`, `delay`, `setVar`, `math` |
| `LogMessage`, `InvokeWorkflowFile`, `InputDialog` | `control.log`, `invoke`, `hitl.ask` |
| `Click`, `TypeInto`, `GetText` and an application-scope container | `web.click` / `type` / `getText`; a scope's URL becomes `web.goto` |
| `AddQueueItem`, `GetTransactionItem`, `SetTransactionStatus` | `queue.addItem` / `getTransactionItem` / `setStatus` |
| `ReadRange`, `WriteRange`, `WriteCell`, `ForEachRow` | `excel.*` (the loop keeps the sheet it was read from) |
| `ForEachFileX`, `MoveFile`, `ReadPDFText` | `file.forEachFile`, `file.move`, `pdf.readText` |
| `Matches`, `DeserializeJson` | `data.regexMatches`, `data.jsonParse` |

Selector strings are routed through `parseSelectorChain`, so a recorded chain arrives as a target
this engine resolves. Expressions are translated only where the meaning is unambiguous
(`Config("Queue")` → `${Config.Queue}`, `RetryNumber + 1` → `control.math`); everything else — an
unknown activity, an untranslatable expression, a scope that does not exist here — lands in the
report with its source line:

```md
| Line | Activity | What happened |
|---|---|---|
| 7 | `ExcelApplicationScope` | no equivalent step — the container is gone, the steps inside it are kept |
```

## Design notes

| Concern | This tool |
|---|---|
| Authoring | `rpa ui` — canvas, palette, properties, live console, queue tab; `rpa pick` for targeting |
| Activities | `web.*` / `desktop.*` / `excel.*` / `file.*` / `queue.*` / `control.*` / `mail.*` / `pdf.*` / `gsheet.*` / `hitl.*` |
| Targeting | strict → fuzzy (scored attributes) → anchor (geometry) → idx, with the matching method logged |
| Recovery | `heal: off/recommend/auto` on a target or step (`--heal` for the run): a failed target re-scores the page locally and reports — or applies — the fix |
| Diagnostics | `rpa doctor` — collectors (runtime, modules, browser, session, tools, project), profiles, report/zip |
| Load checks | `api.load` — VUs × iterations (or a duration) in-flow; p50/p95/p99 + error rate, cross-checked against a real k6 run |
| Input | Playwright drives the real browser; desktop steps are hardware-level via nut.js — one engine, not four modes |
| Step options | `timeoutMs`, `delayBeforeMs`, `delayAfterMs`, `continueOnError`, `retry` |
| Recording | `rpa record <url>` — click through a page, get a draft workflow (unique-id targets first, fuzzy always); `rpa pick` for one element |
| Transaction loop | `rpa init --template transactional` — one file per concern, local queue, exception classes |
| Orchestrator | **Aro**: robots, flows, dispatch, logs, assets — this repo is the robot |
| Queues | local `queue.*` with dispatcher/performer semantics (Aro has a work-queue store; a robot-facing claim/status API is the missing half) |
| Credentials | `${secret.NAME}` resolved once before step 1 (Aro's asset vault on a robot) |
| Still open | a full recorder, ML document understanding (use OCR + regex) |

## Tests

```bash
npm test             # type-check + unit + real-chromium E2E + UI E2E + a fake-Aro protocol suite
npm run test:jest    # every non-e2e suite under Jest
npm run test:vitest  # … and the same set under Vitest
npm run test:runners # both, in that order
npm run test:all     # everything: npm test + the two runners
```

The suites are written once, against `node:test`, and run under three runners: Vitest aliases the
`node:test` specifier to a shim (`test/support/vitest-node-test.ts`), Jest maps it to the same surface
(`test/support/jest-node-test.cjs`), and `node:test`'s `{ skip: reason }` becomes the runner's own skip
so a suite still says why it stepped aside. Scope is every suite except the two `.e2e` files — those
drive a real browser and stay on `npm test`. Jest runs in ESM mode with Babel stripping types, so
neither runner pins a transformer to the TypeScript version; the type-check is its own step
(`npm run test:types`).

The suites: `test/unit.test.ts` (targeting maths, model, control flow, resilience),
`test/web.e2e.test.ts` (a real page: strict/fuzzy/fallback/anchor/retry/screenshot),
`test/steps.test.ts` (queue lifecycle, files, tables, settings, try/catch, retryScope, invoke),
`test/transaction-loop.test.ts` (the scaffolded template: business vs application exception paths),
`test/selector-chain.test.ts` (selector-chain parsing, entry-point arguments, verify),
`test/pack.test.ts` (pack → run from the archive; a tampered file refused),
`test/import.test.ts` (a synthetic dispatcher/performer pair imported and run against the queue; the porting report),
`test/heal.test.ts` (a changed id healed by resemblance, the recommend default, the `--heal` cap,
retry/final-attempt rule, checks that must not heal),
`test/doctor.test.ts` (collector shape, profiles, project validation, the report zip),
`test/record.test.ts` (event→step rules: merging, double-click collapse, target shapes; then a real
session recorded and replayed by a fresh engine),
`test/api-load.test.ts` (VUs × iterations honoured against a counting server; percentiles from real
latencies; failures measured, not thrown),
`test/mobile.test.ts` (both drivers — raw W3C and WebdriverIO — against a mock Appium endpoint:
capabilities shaping, find/click/value/text, touch-actions swipe, session closes with the run),
`test/word.test.ts` (write → read round-trip; a foreign docx reads; LibreOffice opens what we wrote),
`test/gaps.test.ts` (mail, PDF, Sheets, HITL, state machine, UIA),
`test/ui.e2e.test.ts` (the Studio's API — including the Human tab answering a waiting `hitl.ask` — and the page driven in a real browser),
`test/robotProtocol.test.ts` (enrol/heartbeat/claim/logs/cancel/finalize against a fake orchestrator,
including a dispatched `queue.addItem` flow that is asserted on the queue file it wrote).

### Verified

- `npm test` — 120/120, 0 skipped: type-check + unit + real-chromium E2E + UI E2E + a fake-orchestrator
  protocol suite. Mail is exercised against a real SMTP server, PDF text against a generated invoice,
  the queue against its own file store, a package against a tampered archive, a legacy export against
  a synthetic dispatcher/performer pair that is imported and then run, the Studio's panels in a real
  browser, the pick code path against a real chromium click, healing against a page whose element id
  changed for real, recording against a page driven like a user then replayed by a fresh engine,
  `api.load` against a server that counts its own requests, `mobile.*` (both drivers) against a mock
  Appium endpoint that answers the real W3C shapes, and `word.*` round-tripped and re-opened by
  LibreOffice.
- Stack refresh (2026-10-18): runtime floor **Node ≥ 22.19**; Playwright 1.64.1, TypeScript 7.0.2,
  tsx 4.23.15, @types/node 24.19, WebdriverIO 10.0.2 (optional dependency). Mobile ships two drivers
  behind one step set — raw W3C by default (zero-dep) and `driver: "webdriverio"` (the appium-testing
  stack) — both verified against the same mock endpoint on the same wire protocol.
- CLI walk-through (2026-10-18): a workflow targeting the stale `#save-v2` ran `--heal auto` —
  `[warn] target healed … resemblance: id 'save-v2' ≈ 'save-v3' (score 0.86)` — and **Passed** in
  952 ms with 1 heal recorded in `--report`; `--heal off` on the same file failed plainly.
  `rpa doctor --profile robot --project … --out report.zip` reported 6 collectors / 0 warnings /
  0 problems and wrote a zip holding `report.json`.
- Recording walk-through (2026-10-18): a 4-step checkout session — open → type → select → click —
  recorded with strict `[id="…"]` targets plus fuzzy fallbacks, and `rpa run recorded.json` replayed
  it: **Passed** in 333 ms, every target found by its strict selector.
- Load cross-check (2026-10-18), same endpoint, 4 VUs × 40 iterations: `api.load` reported
  **310 rps / p95 18 ms / 0 errors** in-flow; a real **k6** run reported 369 rps / p95 13.8 ms —
  the gap is client overhead, and the numbers agree. Lane coverage and the road to the rest
  (mobile, Office, SAP) live in `docs/automation-lanes.md`.
- Lane walk-through (2026-10-18): `mobile.*` drove a full protocol flow against a mock Appium
  endpoint — session → tap → type → getText → swipe(left, 200 px) — every W3C shape asserted, and
  the session deleted by the run's `finally` even when a step fails. `word.*` wrote a 3-paragraph
  docx that read back identically and that **LibreOffice** opened and exported to the same text.
- Live against the **dev Aro orchestrator** (2026-10-18): robot `rpa-testing-families`
  (`8c638d57-832b-4be7-9d12-2961cfeb1e2e`) enrolled, declared/proved all twelve families
  (`api, config, control, data, excel, file, gsheet, hitl, mail, pdf, queue, web` — Aro's Robots list
  shows exactly that set) and heartbeat was accepted; a flow dispatched from Aro ran its 5 steps and
  **finalized Passed** (run `62797c08-4f90-4894-b616-b8f91046fbd4`). Earlier in the day the same
  round-trip proved the protocol with `rpa-testing-verify` (`web, control, api`, 9 step-log lines).

## Layout

```
src/cli.ts             run / validate / activities / ui / pick / doctor / init / queue / robot
src/workflow/          the format: what a workflow is, and how a target is named
  model.ts             workflow + step model, validation, action aliases
  selector-chain.ts    selector-chain parsing (`<html/><webctrl/>` form)
src/engine/            executing one: the runtime, and what its steps read and write
  engine.ts            step execution, resilience, variables, logging
  targeting.ts         strict / fuzzy / anchor / idx resolution
  store.ts             local queue, settings (JSON/CSV/XLSX), files, tables
src/project/           the files a project is made of
  templates.ts         project templates (basic, transactional)
  pack.ts              the package format (zip + manifest, node:zlib)
  import.ts            the legacy-export importer (XAML → JSON + PORTING-REPORT.md)
src/services/          steps that need something outside Node
  gaps.ts              mail, PDF, Google Sheets, HITL, Windows UIA
src/ui/                the Studio
  server.ts            API + SSE run stream + the static page
  pick.ts              the pick code path (CLI verb and Studio button)
src/robot/aro.ts       the orchestrator protocol (robot side)
src/doctor.ts          environment diagnostics: collectors, profiles, report / zip
src/recorder.ts        the recorder (DOM events → a draft workflow)
src/webdriver.ts       raw W3C WebDriver client (mobile.*, Appium/Selenium/chromedriver)
src/word.ts            .docx read/write over the project zip codec
ui/                    the Studio page (index.html, app.js, style.css) — no build step
test/support/          the shims that let one suite run under node:test, Jest or Vitest
jest.config.mjs        Jest: ESM + Babel type-strip, the non-e2e suite set
vitest.config.ts       Vitest: the same set, `node:test` aliased to the shim
examples/              a web workflow and a desktop+OCR workflow
docs/                  design.md, companion-tools.md, automation-lanes.md
```

Personal project. The workflow format, engine, templates and docs here are original work; no code,
documentation or assets from any commercial RPA product are included.

## License

MIT — see [LICENSE](LICENSE).

