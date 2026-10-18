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
package feed's activity documentation. The Windows install was read in place and never written to.
Scale worth noting: the automation core's browser-driver assembly alone declares 1 922 types /
10 520 methods; the design side ships a dedicated package for recovery configuration (25.10.x line).

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
service, no ML. Code: `src/targeting.ts`, `src/engine.ts`. Tests: `test/heal.test.ts`.

## Adopted: `rpa doctor` diagnostics

Observed model in the diagnostics tool: a run of **collectors** (environment variables, event logs,
log files, registry, computer info), a **profile picker** ("select a diagnostic profile matching
your issue"), per-collector selection before export, and a collect-and-zip action.

Adopted as `rpa doctor`:

- collectors: `runtime`, `dependencies` (which optional modules unlock which capability), `web`
  (playwright + chromium executable), `session` (display/wayland, macOS permissions note), `tools`
  (pdftotext, PowerShell), `project` (workflow validation + writability);
- profiles: `default | web | robot` select the set;
- `--out report.zip` writes a one-entry archive (our own zip code, `src/pack.ts`); `--out *.json`
  writes it plain; `--json` prints it.

Cross-platform by construction: platform differences appear as facts in the report, never as
crashes. Code: `src/doctor.ts`. Tests: `test/doctor.test.ts`.

## Seen, deliberately not adopted (candidate work)

- **Recorder** — the recorder app is an Electron shell over global input hooks plus per-step
  screenshots, with document templates. A *web* recorder built on the same idea (capture DOM
  events, emit draft steps) is the honest port; it stays out of this branch — `rpa pick` is the
  indicate flow for now. (The README already lists a full recorder as intentionally open.)
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
  Reading the legacy form already works (`src/selector-chain.ts`); an author-time converter
  (`rpa upgrade`) is the follow-up.
- **Activity catalog gaps** — the System activity docs (159 entries) list data-table ops, collection
  ops, date/text helpers, `InvokeProcess`, timers and more that this engine does not have yet (the
  engine ships 69 actions across 15 types; healing and doctor are this branch's additions).
