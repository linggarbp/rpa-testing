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

`rpa ui` is the whole Studio: canvas + activity palette + properties + live console + queue tab,
served by one Node process. It works the same on Windows, Linux and macOS (`--no-open` on a headless
host, `--port N` to move it). There is no bundler, no Electron and no build step — the page is three
static files in `ui/`.

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
`rpa robot --once` prints the declared/proved pair.

## Activities

```
web        goto click type hover selectOption getText getAttribute elementExists
           waitForElement pressKeys scroll screenshot assertText
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
api        request
desktop    move click doubleClick rightClick type scroll pressKey drag clipboardCopy
           screenshot waitForImage clickImage uia                 (uia = PowerShell UI Automation, Windows)
ocr        recognize
ai-vision  decide                      (project's own OpenAI-compatible endpoint; key travels with the job)
```

Every step also accepts `timeoutMs`, `retry`, `retryDelayMs`, `continueOnError`, `delayBeforeMs`,
`delayAfterMs` and (for reads) `saveAs`.

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

`rpa pick <url>` opens a browser, lets you click an element, and prints the target JSON to paste in
— the "indicate element" workflow, without a designer.

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
rpa run <workflow.json>      run it here (--headed, --var k=v, --report out.json, --json)
rpa validate <workflow.json…>  syntax + shape, no execution
rpa activities                 the catalog above
rpa ui                         Studio in the browser (--project <dir>, --port N, --no-open)
rpa pick <url>                 click an element, get its target JSON (--out target.json)
rpa init <dir>                 scaffold (--template basic|transactional)
rpa queue <name> | add <name> <ref> [json]   the local transaction queue
rpa hitl [answer <id> <value>]  human-in-the-loop questions (hitl.ask waits on these)
rpa robot …                    connect to Aro and take dispatched flows
```

## Design notes

| Concern | This tool |
|---|---|
| Authoring | `rpa ui` — canvas, palette, properties, live console, queue tab; `rpa pick` for targeting |
| Activities | `web.*` / `desktop.*` / `excel.*` / `file.*` / `queue.*` / `control.*` / `mail.*` / `pdf.*` / `gsheet.*` / `hitl.*` |
| Targeting | strict → fuzzy (scored attributes) → anchor (geometry) → idx, with the matching method logged |
| Input | Playwright drives the real browser; desktop steps are hardware-level via nut.js — one engine, not four modes |
| Step options | `timeoutMs`, `delayBeforeMs`, `delayAfterMs`, `continueOnError`, `retry` |
| Recording | `rpa pick` indicates one element; workflows are authored as JSON |
| Transaction loop | `rpa init --template transactional` — one file per concern, local queue, exception classes |
| Orchestrator | **Aro**: robots, flows, dispatch, logs, assets — this repo is the robot |
| Queues | local `queue.*` with dispatcher/performer semantics; an Aro queue service is the next orchestrator feature |
| Credentials | `${secret.NAME}` resolved once before step 1 (Aro's asset vault on a robot) |
| Still open | table extraction (`web.extractTable`), structured log fields, packages, a full recorder, ML document understanding (use OCR + regex) |

## Tests

```bash
npm test        # type-check + unit + real-chromium E2E + UI E2E + a fake-Aro protocol suite
```

The suites: `test/unit.test.ts` (targeting maths, model, control flow, resilience),
`test/web.e2e.test.ts` (a real page: strict/fuzzy/fallback/anchor/retry/screenshot),
`test/steps.test.ts` (queue lifecycle, files, tables, settings, try/catch, retryScope, invoke),
`test/transaction-loop.test.ts` (the scaffolded template: business vs application exception paths),
`test/selector-chain.test.ts` (selector-chain parsing, entry-point arguments, verify),
`test/gaps.test.ts` (mail, PDF, Sheets, HITL, state machine, UIA),
`test/ui.e2e.test.ts` (the Studio's API and the page driven in a real browser),
`test/robotProtocol.test.ts` (enrol/heartbeat/claim/logs/cancel/finalize against a fake orchestrator).

### Verified

- `npm test` — 67/67: type-check + unit + real-chromium E2E + UI E2E + a fake-orchestrator protocol
  suite. Mail is exercised against a real SMTP server, PDF text against a generated invoice, the queue
  against its own file store.
- Live round-trip against the **dev Aro orchestrator** (2026-10-18): robot `rpa-testing-verify`
  (`9d774ab2-d467-44cc-bd43-f4b60dac0c35`) enrolled, proved `web, control, api`, heartbeat accepted;
  a flow dispatched from Aro to that robot ran and **finalized Passed** in ~0.9 s
  (run `141c9b52-4bed-45b9-8dcf-e4d7d381411c`), with all 9 step-log lines readable from Aro's run
  history. Aro's Robots list showed it `Online` with `caps=["api","control","web"]`.

## Layout

```
src/model.ts        workflow + step model, validation, action aliases
src/targeting.ts    strict / fuzzy / anchor / idx resolution
src/engine.ts       step execution, resilience, variables, logging
src/store.ts        local queue, settings (JSON/CSV/XLSX), files, tables
src/templates.ts    project templates (basic, transactional)
src/selector-chain.ts  selector-chain parsing (`<html/><webctrl/>` form)
src/gaps.ts         mail, PDF, Google Sheets, HITL, Windows UIA
src/robot/aro.ts    the orchestrator protocol (robot side)
src/cli.ts          run / validate / activities / ui / pick / init / queue / robot
src/ui/server.ts    the Studio server (API + SSE run stream + static SPA)
ui/                 the Studio page (index.html, app.js, style.css) — no build step
examples/           a web workflow and a desktop+OCR workflow
docs/               design.md
```

Personal project. The workflow format, engine, templates and docs here are original work; no code,
documentation or assets from any commercial RPA product are included.

## License

MIT — see [LICENSE](LICENSE).

