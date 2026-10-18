# Design

Three pieces, one direction of dependency: **workflow JSON → engine → steps**. The robot is a
transport around the engine; the CLI is a view over it.

```
workflow.json ──► parseWorkflow ──► validateWorkflow ──► Engine.run ──► RunResult
                                                            │
                            ┌───────────────────────────────┼──────────────────────────────┐
                            ▼                               ▼                              ▼
                    targeting (strict/                 control / api /             desktop (nut.js) /
                    fuzzy/anchor/idx)                  ai-vision / ocr             screenshot evidence
                            │
                        Playwright page
```

## The step model

One shape for every step:

```jsonc
{ "type": "web", "action": "click", "target": { … },
  "timeoutMs": 30000, "retry": 2, "retryDelayMs": 500, "continueOnError": false,
  "delayBeforeMs": 0, "delayAfterMs": 300, "saveAs": "whatever" }
```

- `type` picks the engine (`web`, `desktop`, `api`, `control`, `ocr`, `ai-vision`).
- `action` names the activity; aliases fold in (`navigate`→`goto`, `fill`→`type`,
  `wait`→`delay`, `assign`→`setVar`) so recorded spelling and Aro flow JSON both run.
- The resilience fields are *per step, on every type* — continue-on-error, delay before/after,
  timeout, plus a retry. They live in one wrapper
  (`Engine.runStep`), so no activity can forget them.
- `saveAs` is how a step hands a value to later steps: `${name}` and `{{name}}` interpolate it.

Nesting is a property of a container step (`then`/`else`/`steps`), validated recursively to depth 5 —
the same budget Aro's server-side validator enforces, so a definition saved in Aro runs here
unchanged.

## Targeting

Four methods, tried in that order:

1. **strict** — `strict` then `strictAny[]`; the first candidate that resolves wins. A candidate
   waits for its slice of the timeout, so a late-rendered element is *waited for*, not retried.
2. **fuzzy** — the tag's visible elements are collected and scored: each expected attribute by
   Normalised Levenshtein similarity (containment floors at 0.9), `exact` as a hard gate, `text`
   scored the same way. Candidates below `threshold` (default 0.7) are dropped; `idx` picks among
   the survivors, best first.
3. **anchor** — a second target resolved first, then candidates filtered by geometric relation
   (`left`/`right`/`above`/`below`/`near`) and ordered by centre distance. Anchors apply to *both*
   strict and fuzzy matches (a deliberate divergence from tools that apply anchors to fuzzy only:
   a strict selector that matches three inputs is exactly when an anchor earns its keep).
4. **idx** — 1-based nth match, with a bounded wait for the list to reach that length.

Result: nothing is silent. The log names the method that matched (`target found by fuzzy selector
(score 0.91, 3 match(es))`), and a failure names everything that was tried.

## Engine

- **Variables** are one flat map of strings (objects arrive as JSON text); `interpolate` replaces
  `${name}` / `{{name}}` and blanks unknown names. A step that must not run on a blank value checks
  for it (the robot resolves `${secret.*}` before step 1 and refuses otherwise).
- **Conditions** deliberately stop at `==`, `!=`, `!` and truthiness. There is no `eval`, no
  expression language to secure, and a typo skips a branch instead of executing an injection.
- **Cancellation** is a hook (`isCancelled`) asked before every step: the robot answers it by
  polling the orchestrator, a local run answers "never". The run stops at a step boundary.
- **Evidence**: screenshots land in `runs/<timestamp>/` unless a step names a path; every line of
  the run is in the `RunResult.logs` array, which the CLI prints (or `--report` writes) and the
  robot ships to Aro in batches of 20 / every 2 seconds.
- **Optional modules** are imported lazily with a message that says what to install
  (`playwright`, `@nut-tree-fork/nut-js`, `tesseract.js`). A host with no desktop module still runs
  everything else — the same rule that lets Aro's robot run on a bare Node.

## Robot (orchestrator protocol)

The robot is deliberately thin, because the control plane already exists (Aro): enrol by name with a
project API key, heartbeat what it *proved* it can do, long-poll a claim, run the definition with the
engine, ship logs, poll for cancellation, finalize the run with its outcome. Every endpoint, header
and body is asserted in `test/robotProtocol.test.ts` against a fake orchestrator, so a change on the
Aro side that breaks the contract fails here first.

Two details worth keeping:

- The machine key is re-minted by the orchestrator on every enrolment; the project API key is used
  once and never stored. Nothing long-lived lives on the robot.
- `proved` ≠ `declared`: modules are imported to check they load, and the proved set is what the
  orchestrator routes on — a machine without a GUI is never handed a desktop flow.

## Roadmap

Ordered by what a personal tool notices first. Nothing here is blocked on Aro.

| Gap | Why it is a gap | Where it would land |
|---|---|---|
| Queues in Aro | The orchestration half of the pattern: items → per-item retries → outcomes. Today `queue.*` is local and dispatcher/performer share a folder | **Aro** (control plane): entity + dispatch; the robot claims items |
| Aro validating the new step families | Its `FlowDefinitionValidator` only allows its own actions, so a *dispatched* flow cannot use `queue.*`, `excel.*`, `try`, `invoke`, … yet | **Aro**: validator + designer catalog (small PR) |
| Schedules/triggers for flows | Aro schedules exist for test runs, not flows yet | **Aro** |
| Mail steps (`mail.send`, `mail.receive`) | closed: nodemailer / imapflow, both optional | here |
| `pdf.readText` | closed: `pdftotext` | here |
| Google Sheets / WebAPI / human-in-the-loop | closed: `gsheet.*`, `api.request`, `hitl.ask` | here (Sheets REST) / file-based HITL |
| State machine | closed: `control.stateMachine` | here |
| Windows UIA | partial: `desktop.uia` over PowerShell UIAutomation, Windows hosts only | here |
| Table extraction | closed: `web.extractTable` — header-keyed rows in one page round-trip | here |
| Structured log fields | closed: `control.log.fields` on the `LogLine`, printed `{k=v}` and shipped to Aro | here |
| Document Understanding | open: needs trained models; OCR + regex is the substitute | out of scope |
| Full recorder | `rpa pick` indicates one element; a recorder captures a session | here: convert a Playwright trace into steps |
| Packages | closed: `rpa pack` writes a zip + `manifest.json` (sha256 per file), `rpa run` verifies and runs it. No signing — the manifest proves integrity, not authorship | here |
| Coded workflows (C#) | A code-first authoring mode | not planned — the engine is Node |

The Studio (`rpa ui`) shipped in this pass; a native shell (Electron/Tauri) would only wrap it, and
the local web UI already runs on Windows, Linux and macOS without one. It is a thin client over the
same server: the canvas and palette edit the workflow, the console renders the run's own log lines
(structured fields included), the queue tab adds items and sets a status, the Human tab lists pending
`hitl.ask` requests and answers them, and **Pick element** calls `POST /api/pick` — which is the
`rpa pick` code path, not a second implementation.

## Testing strategy

- `test/unit.test.ts` — targeting maths, model/validator, interpolation, control flow, resilience.
  No browser, no network beyond a stubbed `fetch`.
- `test/web.e2e.test.ts` — a real chromium against a local HTTP server: strict, fuzzy, fallback,
  anchor, reads, late elements, screenshots. Skipped (not failed) where no browser exists.
- `test/steps.test.ts` — the queue lifecycle, files, tables/settings, try/catch classification,
  retryScope, invoke and arithmetic/comparisons.
- `test/transaction-loop.test.ts` — the scaffolded template end to end: business exception is terminal,
  application exception retries exactly `MaxRetryNumber` times.
- `test/ui.e2e.test.ts` — the Studio's HTTP surface plus the page in a real browser (add an activity,
  click Run, watch the console).
- `test/robotProtocol.test.ts` — a fake orchestrator that records every call and asserts the
  protocol: enrol, heartbeat, claim, logs, cancel, finalize — including the failure path.
