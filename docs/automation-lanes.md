# Automation lanes — coverage and the road

The ambition: one engine for every lane — desktop, web, mobile, API, integration apps (Office, SAP,
…), OCR, AI vision, and the agentic extras. This file is the honest scoreboard. A lane is "done"
only when a step exists **and** a test exercises it for real; everything else is named as next or
deliberately out.

| lane | today | exercised by | next |
|---|---|---|---|
| web | `web.*` on Playwright — targeting strict→fuzzy→anchor with **healing**, waits, tables, screenshots, `rpa record` | `test/web.e2e`, `test/heal`, `test/record` | iframes as first-class, download handling |
| desktop | `desktop.*` (nut.js: mouse/keyboard/images) + `desktop.uia` (Windows PowerShell bridge) | `test/gaps` (UIA script + honest platform refusal) | window enumeration; an OS-level recorder stays a separate program |
| mobile | `mobile.*` over a **raw W3C WebDriver client** (stdlib HTTP — Appium 2, Selenium and chromedriver all answer it): session/end/tap/type/getText/waitFor/swipe/screenshot, session closed with the run | `test/mobile` — protocol-level e2e against a mock Appium endpoint (capabilities shaping, element ops, touch actions). A physical run needs a device + Appium server, which this host does not have — no fake pass | real-device CI run once a device is attached; `mobile.end`-less workflows already close cleanly |
| api | `api.request`; `api.load` (VUs × iterations or a duration → p50/p95/p99, rps, error rate) | `test/steps`, `test/api-load` | Postman collection import (v2.1 export), response schema checks |
| integration: Office | `excel.*` (CSV native, XLSX via exceljs), `mail.*` (SMTP/IMAP), `pdf.readText`, **`word.*`** (docx read/write, stdlib zip + XML) | `test/steps`, `test/gaps`, `test/word` (LibreOffice cross-check) | PowerPoint later |
| integration: SAP | via `web.*` on the browser UI or `api.request` on OData | — | `sap.*` needs a real use case first: GUI scripting is a Windows bridge (like UIA), OData/RFC is portable |
| OCR | `ocr.recognize` (tesseract.js) | `test/gaps` | region hints; PDF→text→OCR fallback chain |
| AI vision | `ai-vision.decide` (project endpoint; the key travels with the job) | `test/gaps` | screenshot → structured fields with confidence gates |
| agentic | deliberately none: flows stay deterministic — `ai-vision.decide` picks a step, it never rewrites the run | — | keep it that way until a use case earns it |

## Reading the ecosystem: source first, REA for binaries

The frameworks this engine builds on are open source (Playwright, WebdriverIO, Appium, Selenium,
newman, nut.js). For those, **source is the right instrument** — exact, and quick. REA owns the
binary side, and this is what it found where it was used:

- **k6** (the official image's binary, read with REA's Go inspection — no disassembler): built with
  `go1.27.1`, main module `go.k6.io/k6/v2 v2.3.0`, 84 module dependencies; the browser module rides
  chromedp/CDP — the same protocol our web driver speaks. Evidence `ev_10423df5…`.
- **Cross-check on the same endpoint** (4 VUs × 40 iterations, ~10 ms handler):

  | | requests | throughput | p95 |
  |---|---|---|---|
  | k6 (docker, real) | 40 | 369 rps | 13.8 ms |
  | `api.load` (this engine, in-flow) | 40 | 310 rps | 18 ms |

  The gap is fetch/undici overhead — the point is that the numbers live *inside the workflow* next
  to the steps they protect.
- **Postman** is Electron: REA's JavaScript-application route (same as the recorder analysis) applies
  to its app.asar when the app itself needs reading; **newman** is source.
- **nut.js**: the prebuilt native addon (`.node`) is the binary half — a native-REA target only if it
  ever needs verifying; its protocol lives in source.
- **JMeter**: jars are JVM bytecode, and nothing in this project needs them yet.

Rule of thumb, learned the hard way: *"read one behaviour sentence"* → grep the artifact; *"who is
this, how big is it, what shipped vs the repo"* → REA; *"how does the Python/JS/Java source work"* →
the source.
