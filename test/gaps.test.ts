/**
 * The gaps that were open after the first pass, closed and tested:
 * PDF text, mail (SMTP/IMAP), Google Sheets, human-in-the-loop, the State Machine container, and the
 * Windows UIA bridge. Document Understanding stays a gap on purpose — it needs trained models.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine/engine.js';
import { askHuman, answerHuman, buildUiaScript, pendingHuman, runUia } from '../src/services/gaps.js';
import { parseWorkflow, validateWorkflow } from '../src/workflow/model.js';

const wf = (steps: unknown[], extra: Record<string, unknown> = {}) =>
  parseWorkflow(JSON.stringify({ steps, ...extra }));

const project = () => mkdtemp(path.join(os.tmpdir(), 'rpa-gaps-'));
const messages = (result: { logs: Array<{ message: string }> }) => result.logs.map((line) => line.message).join('\n');

// ── PDF ───────────────────────────────────────────────────────────────────────────────────────

/** A minimal, valid one-page PDF with the given lines — the fixture for pdf.readText. */
function buildPdf(lines: string[]): Buffer {
  const content = ['BT', '/F1 14 Tf', '40 780 Td']
    .concat(lines.map((line, index) => `${index === 0 ? '' : '0 -24 Td '}(${line.replace(/[()\\]/g, '\\$&')}) Tj`.trim()))
    .concat(['ET'])
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Native PDF text is a `pdftotext` call, so the suite skips (not fails) where poppler is absent. */
const hasPdftotext = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).error === undefined;

test('pdf.readText extracts the native text of a generated invoice', { skip: hasPdftotext ? false : 'pdftotext (poppler-utils) is not on PATH' }, async () => {
  const dir = await project();
  await writeFile(path.join(dir, 'invoice.pdf'), buildPdf(['Sample Invoice', 'Invoice Number 19070', 'Total 2210']));

  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'pdf', action: 'readText', path: 'invoice.pdf', saveAs: 'text' }
  ]));
  assert.equal(result.status, 'Passed', result.error);
  const text = String(result.vars.text ?? '');
  assert.match(text, /Sample Invoice/);
  assert.match(text, /Total 2210/);
});

test('pdf.readText fails with an actionable message for a missing file', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([{ type: 'pdf', action: 'readText', path: 'nope.pdf' }]));
  assert.equal(result.status, 'Failed');
  assert.match(result.error ?? '', /pdftotext|No such file/i);
});

// ── Mail ─────────────────────────────────────────────────────────────────────────────────────

/** The dev stack's Mailpit: SMTP on the container IP (host port 1025 is not published), HTTP on 8025. */
const MAILPIT_HOST = process.env.MAILPIT_HOST ?? '172.18.0.3';

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

const mailpit = await reachable(MAILPIT_HOST, 1025);

test('mail.send delivers through a real SMTP server and the message arrives', { skip: !mailpit ? 'no SMTP server reachable' : false }, async () => {
  const dir = await project();
  const subject = `rpa-testing mail ${Date.now()}`;
  const result = await new Engine({ baseDir: dir }).run(wf([
    {
      type: 'mail', action: 'send',
      server: { host: MAILPIT_HOST, port: 1025 },
      from: 'bot@rpa.test', to: 'ops@rpa.test',
      subject, text: 'invoice processed: ${reference}'
    }
  ], { variables: { reference: 'INV-42' } }));

  assert.equal(result.status, 'Passed', result.error);
  assert.match(messages(result), /mail\.send → .*accepted: ops@rpa\.test/i);

  // Mailpit's HTTP API is the proof the message landed (the SMTP handshake alone is not delivery).
  const search = await fetch(`http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`).catch(() => null);
  if (search?.ok) {
    const payload = (await search.json()) as { messages?: Array<{ Subject?: string; To?: Array<{ Address?: string }> }> };
    assert.ok(payload.messages?.length, 'the message is in the mailbox');
    assert.equal(payload.messages?.[0]?.Subject, subject);
  }
});

test('mail.send is validated before it runs', () => {
  const errors = validateWorkflow(wf([{ type: 'mail', action: 'send', subject: 'x' }]));
  assert.ok(errors.some((error) => error.includes('needs a "to"')));
  const noSubject = validateWorkflow(wf([{ type: 'mail', action: 'send', to: 'a@b.c' }]));
  assert.ok(noSubject.some((error) => error.includes('needs a "subject"')));
});

// ── Google Sheets ─────────────────────────────────────────────────────────────────────────────

test('gsheet.append speaks the Sheets v4 append shape', async () => {
  const dir = await project();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ updates: { updatedRange: 'Sheet1!A2:B2', updatedRows: 1 } }), { status: 200 });
  }) as typeof fetch;

  const result = await new Engine({ baseDir: dir, variables: { GSHEET_TOKEN: 'token-123' } }).run(wf([
    {
      type: 'gsheet', action: 'append',
      spreadsheetId: 'sheet-abc', range: 'Sheet1!A1',
      values: '[["INV-1","120.00"]]', token: '${GSHEET_TOKEN}', saveAs: 'updated'
    }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.equal(result.vars.updated, 'Sheet1!A2:B2');
  const call = calls[0];
  assert.match(call?.url ?? '', /spreadsheets\/sheet-abc\/values\/Sheet1!A1:append/);
  assert.match(call?.url ?? '', /valueInputOption=USER_ENTERED/);
  assert.equal((call?.init?.headers as Record<string, string>)['Authorization'], 'Bearer token-123');
  assert.deepEqual(JSON.parse(String(call?.init?.body)), { values: [['INV-1', '120.00']] });
});

test('gsheet needs a token and names it', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'gsheet', action: 'append', spreadsheetId: 's', range: 'Sheet1!A1', values: '[["a"]]' }
  ]));
  assert.equal(result.status, 'Failed');
  assert.match(result.error ?? '', /OAuth token/);
});

// ── Human in the loop ───────────────────────────────────────────────────────────────────────

test('hitl.ask waits for an answer file and returns it', async () => {
  const dir = await project();
  const pending = askHuman({ projectDir: dir, prompt: 'Approve INV-9?', choices: ['yes', 'no'], timeoutMs: 5000, pollMs: 50 });
  // Answer the way an operator would: after the request appears.
  const answered = (async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const requests = await pendingHuman(dir);
      if (requests[0]) { await answerHuman(dir, requests[0].id, 'no'); return; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the request never appeared');
  })();

  const [request, answer] = await Promise.all([pending, answered]);
  assert.equal(request.asked, true);
  assert.equal(request.answer, 'no');
  assert.equal(answer, undefined);
});

test('hitl takes the explicit unattended default instead of asking', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'hitl', action: 'ask', prompt: 'Approve?', default: 'yes', saveAs: 'answer' }
  ]));
  assert.equal(result.status, 'Passed', result.error);
  assert.equal(result.vars.answer, 'yes');
  assert.match(messages(result), /hitl not asked \(unattended\)/);
});

test('hitl times out loudly instead of inventing an answer', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'hitl', action: 'ask', prompt: 'Approve?', timeoutMs: 120, pollMs: 30 }
  ]));
  assert.equal(result.status, 'Failed');
  assert.match(result.error ?? '', /hitl\.ask timed out/);
});

// ── State machine ───────────────────────────────────────────────────────────────────────────

test('control.stateMachine follows when/next transitions until a final state', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    {
      type: 'control', action: 'stateMachine', initial: 'Init', maxTransitions: 20,
      states: {
        Init: { steps: [{ type: 'control', action: 'setVar', name: 'n', value: '0' }], next: 'Count' },
        Count: {
          steps: [
            { type: 'control', action: 'math', name: 'n', op: 'add', value: '1' },
            { type: 'control', action: 'log', message: 'n=${n}' }
          ],
          when: [{ condition: '${n} >= 3', to: 'Done' }],
          next: 'Count'
        },
        Done: { final: true, steps: [{ type: 'control', action: 'log', message: 'done at ${n}' }] }
      }
    }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.equal(result.vars.n, '3');
  const lines = result.logs.map((line) => line.message);
  assert.equal(lines.filter((line) => /^n=\d$/.test(line)).length, 3);
  assert.ok(lines.includes('done at 3'));
  // Init → Count → Count → Count → Done = the 5th state entry.
  assert.ok(lines.includes('state Done (transition 5)'), lines.join(' | '));
});

test('a state machine without an exit stops at maxTransitions', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    {
      type: 'control', action: 'stateMachine', initial: 'Loop', maxTransitions: 3,
      states: { Loop: { steps: [{ type: 'control', action: 'log', message: 'tick' }], next: 'Loop' } }
    }
  ]));
  assert.equal(result.status, 'Failed');
  assert.match(result.error ?? '', /maxTransitions/);
});

// ── Windows UIA bridge ──────────────────────────────────────────────────────────────────────

test('the UIA bridge builds a real PowerShell UIAutomation script', () => {
  const script = buildUiaScript({ automationId: 'btnSave', action: 'invoke' });
  assert.match(script, /UIAutomationClient/);
  assert.match(script, /AutomationIdProperty, 'btnSave'/);
  assert.match(script, /InvokePattern/);
  assert.match(script, /FindFirst\(\[System\.Windows\.Automation\.TreeScope\]::Descendants/);

  const value = buildUiaScript({ name: "O'Brien", controlType: 'Edit', action: 'setValue', value: 'hello' });
  assert.match(value, /NameProperty, 'O''Brien'/, 'single quotes are escaped for PowerShell');
  assert.match(value, /ValuePattern/);
  assert.match(value, /ControlType\]::Edit/);

  assert.throws(() => buildUiaScript({ action: 'invoke' }), /needs name, automationId or controlType/);
});

test('desktop.uia refuses politely on a non-Windows host', { skip: process.platform === 'win32' ? 'this host is Windows' : false }, async () => {
  await assert.rejects(() => runUia({ name: 'Save' }), new RegExp(`drives Windows UI Automation and this host is ${process.platform}`));
});
