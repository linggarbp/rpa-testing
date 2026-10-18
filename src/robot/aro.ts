/**
 * The robot side of an Aro orchestrator. Aro is the control plane — robot registry, flow
 * definitions, dispatch, run logs, the asset vault. This file is the other half: a machine that
 * connects, proves what it can do, claims a flow, runs it with the local engine and reports back.
 *
 * The protocol is Aro's own, byte for byte (see the Aro repo's src/Aro.Agent/src/services/robot):
 *
 *   POST {api}/api/projects/{projectId}/robots/enroll            X-API-Key      → { robot, machineKey }
 *   POST {api}/api/projects/{projectId}/robots/{robotId}/heartbeat  X-ARO-Robot-Key
 *   POST {api}/api/projects/{projectId}/robots/{robotId}/jobs/claim?waitSeconds=N   X-ARO-Robot-Id/Key
 *   POST {api}/api/projects/{projectId}/robots/{robotId}/jobs/{jobId}/logs
 *   GET  {api}/api/projects/{projectId}/robots/{robotId}/runs/{flowRunId}/cancel
 *   POST {api}{finalizePath}?callbackToken=…                     → { status, error, robotId }
 *
 * The project API key is used exactly once (enrolment) and never stored; Aro rotates the machine
 * key on every enrolment, so nothing long-lived sits on the machine.
 */
import { spawnSync } from 'node:child_process';
import { backendReport } from '../services/desktop/backend.js';
import { Engine, formatLogLine, type LogLine } from '../engine/engine.js';
import { parseWorkflow, type Step } from '../workflow/model.js';

export interface AroRobotOptions {
  apiUrl: string;
  projectId: string;
  /** Project API key — enrolment only. */
  apiKey?: string;
  /** Pinned identity (the advanced branch: a machine that must not hold a project API key). */
  robotId?: string;
  robotKey?: string;
  name: string;
  mode?: string;
  capabilities?: string[];
  heartbeatSeconds?: number;
  claimWaitSeconds?: number;
  headless?: boolean;
  /**
   * The folder a dispatched flow resolves its project-relative paths in (`config.load`, `invoke`,
   * files, the queue). Defaults to the robot's working directory.
   */
  baseDir?: string;
}

/** A flow job as Aro publishes it. The AI endpoint travels inside the job — there is no host credential. */
export interface FlowTask {
  jobId: string;
  flowRunId: string;
  projectId: string;
  flowId: string;
  flowName: string;
  definition: string;
  robotId?: string;
  finalizePath?: string;
  callbackToken?: string;
  aiBaseUrl?: string;
  aiModel?: string;
  aiApiKey?: string;
}

export interface PreflightReport {
  ok: boolean;
  apiUrl: string;
  projectId: string;
  robotId: string;
  name: string;
  mode: string;
  declared: string[];
  proved: string[];
  heartbeatStatus: number | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Is a command on PATH? Used to prove a capability that depends on a binary, not a module. */
function hasBinary(command: string): boolean {
  return spawnSync(command, ['-v'], { stdio: 'ignore' }).error === undefined;
}

/**
 * Every step family this engine implements. A robot declares all of them by default and the probe
 * decides which ones the host can actually run, which is the pair an orchestrator shows and routes
 * on: `declared` is a request, `proved` is what loaded here.
 */
export const ENGINE_CAPABILITIES = [
  'desktop', 'control', 'api', 'queue', 'excel', 'file', 'data', 'config', 'mail', 'pdf', 'gsheet', 'hitl'
] as const;

/** Families the engine runs with nothing installed — proved by existing, not by loading a module. */
const BUILT_IN_CAPABILITIES = ['api', 'control', 'queue', 'excel', 'file', 'data', 'config', 'gsheet', 'hitl'];

export class AroRobot {
  private robotId = '';
  private machineKey = '';
  private declared: string[];
  private proved: string[] = [];
  private busy = false;
  private readonly logs: Array<{ message: string; type: string; ts: string; fields?: Record<string, string> }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AroRobotOptions) {
    this.declared = options.capabilities ?? [...ENGINE_CAPABILITIES];
    this.robotId = options.robotId ?? '';
    this.machineKey = options.robotKey ?? '';
  }

  /**
   * Which capabilities this host actually holds. Declared is what the operator asked for; proved is
   * what loaded — an orchestrator routes on the proved set, so a machine without a desktop display
   * is never handed a desktop flow.
   *
   * The families a transactional project uses are proved by *running the engine*: `queue`, `excel`,
   * `file`, `data`, `config`, `gsheet` and `hitl` need nothing installed. `mail` needs nodemailer or
   * imapflow, `pdf` needs the poppler binary, and those two are proved only when they are here.
   */
  static async probe(declared: string[]): Promise<string[]> {
    const proved: string[] = [];
    const loadable = async (module: string) => {
      try {
        await import(module);
        return true;
      } catch {
        return false;
      }
    };
    if (declared.includes('desktop') && (await backendReport()).some((row) => row.available)) proved.push('desktop');
    if (declared.includes('ocr') && (await loadable('tesseract.js'))) proved.push('ocr');
    if (declared.includes('mail')
      && ((await loadable('nodemailer')) || (await loadable('imapflow')))) proved.push('mail');
    if (declared.includes('pdf') && hasBinary('pdftotext')) proved.push('pdf');
    for (const capability of declared) {
      if (BUILT_IN_CAPABILITIES.includes(capability) && !proved.includes(capability)) proved.push(capability);
    }
    return proved;
  }

  private get base(): string {
    return `${this.options.apiUrl.replace(/\/+$/, '')}/api/projects/${this.options.projectId}/robots`;
  }

  private get robotHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'X-ARO-Robot-Id': this.robotId, 'X-ARO-Robot-Key': this.machineKey };
  }

  /** Enrol by name (or accept a pinned identity) and probe capabilities. Returns the robot id. */
  async connect(): Promise<string> {
    this.proved = await AroRobot.probe(this.declared);

    if (this.robotId && this.machineKey) return this.robotId;
    if (!this.options.apiKey) {
      throw new Error('No robot identity: pass --api-key (enrol by name) or --robot-id/--robot-key (pinned).');
    }

    const response = await fetch(`${this.base}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this.options.apiKey },
      body: JSON.stringify({
        name: this.options.name,
        operatingSystem: process.platform,
        mode: this.options.mode ?? 'Unattended',
        capabilities: JSON.stringify(this.declared)
      })
    });
    if (!response.ok) {
      throw new Error(`Enrolment was refused (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
    const payload = (await response.json()) as { robot?: { id?: string }; machineKey?: string };
    if (!payload.robot?.id || !payload.machineKey) throw new Error('Enrolment returned no robot id or machine key.');
    this.robotId = payload.robot.id;
    this.machineKey = payload.machineKey;
    return this.robotId;
  }

  /** One heartbeat, described in plain lines — what `--once` prints so a host is testable. */
  async preflight(): Promise<PreflightReport> {
    await this.connect();
    const status = await this.heartbeat();
    return {
      ok: status !== null && status >= 200 && status < 300,
      apiUrl: this.options.apiUrl,
      projectId: this.options.projectId,
      robotId: this.robotId,
      name: this.options.name,
      mode: this.options.mode ?? 'Unattended',
      declared: this.declared,
      proved: this.proved,
      heartbeatStatus: status
    };
  }

  describe(report: PreflightReport): string {
    const lines = [
      `robot     : ${report.name} (${report.robotId})`,
      `project   : ${report.projectId}`,
      `api       : ${report.apiUrl}`,
      `declared  : ${report.declared.join(', ') || '(none)'}`,
      `proved    : ${report.proved.join(', ') || '(none)'}`,
      report.ok
        ? `heartbeat : accepted (HTTP ${report.heartbeatStatus}) — Aro sees this machine`
        : `heartbeat : REJECTED (HTTP ${report.heartbeatStatus ?? 'unreachable'}) — check the API URL and key`
    ];
    const unproved = report.declared.filter((capability) => !report.proved.includes(capability));
    if (unproved.length > 0) lines.push(`declared only: ${unproved.join(', ')} — no module loaded for these; dispatch will not route them here`);
    return lines.join('\n');
  }

  private async heartbeat(): Promise<number | null> {
    try {
      const response = await fetch(`${this.base}/${this.robotId}/heartbeat`, {
        method: 'POST',
        headers: { ...this.robotHeaders, 'X-ARO-Robot-Key': this.machineKey },
        body: JSON.stringify({
          operatingSystem: process.platform,
          capabilities: JSON.stringify(this.declared),
          probedCapabilities: JSON.stringify(this.proved),
          busy: this.busy
        })
      });
      return response.status;
    } catch {
      return null;
    }
  }

  /** One claim. 204 (nothing yet) is a normal answer, not an error. */
  async claimOnce(waitSeconds: number): Promise<FlowTask | null> {
    const url = `${this.base}/${this.robotId}/jobs/claim?waitSeconds=${Math.max(1, Math.min(waitSeconds, 25))}`;
    const response = await fetch(url, { method: 'POST', headers: this.robotHeaders });
    if (response.status === 204) return null;
    if (response.status === 429) {
      const asked = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(asked) && asked > 0 ? asked * 1000 : 30000);
      return null;
    }
    if (!response.ok) throw new Error(`The orchestrator refused the claim (HTTP ${response.status}).`);
    const task = (await response.json()) as FlowTask;
    if (task.robotId && task.robotId !== this.robotId) {
      throw new Error(`Claimed a job addressed to another robot (${task.robotId}); dropping it.`);
    }
    return task;
  }

  /** Connect and work forever: heartbeat in the background, claim → run → report in the foreground. */
  async start(): Promise<void> {
    await this.connect();
    console.log(this.describe(await this.preflight()));
    void this.heartbeatLoop();
    for (;;) {
      const task = await this.claimOnce(this.options.claimWaitSeconds ?? 25).catch((error: Error) => {
        console.error(`claim failed: ${error.message}`);
        return null;
      });
      if (!task) continue;
      await this.runTask(task);
    }
  }

  private async heartbeatLoop(): Promise<void> {
    for (;;) {
      await sleep((this.options.heartbeatSeconds ?? 15) * 1000);
      const status = await this.heartbeat();
      if (status !== null && (status < 200 || status >= 300)) console.error(`heartbeat rejected (HTTP ${status})`);
    }
  }

  /** Run one dispatched flow: secrets first, then the steps, then the outcome to the orchestrator. */
  async runTask(task: FlowTask): Promise<'Passed' | 'Failed'> {
    this.busy = true;
    console.log(`flow      : ${task.flowName} (run ${task.flowRunId}, job ${task.jobId})`);
    const workflow = parseWorkflow(task.definition);
    const variables: Record<string, unknown> = { ...(await this.resolveSecrets(task)) };
    // ai-vision steps read the project endpoint from the job, never from the host.
    if (task.aiBaseUrl) variables.aiBaseUrl = task.aiBaseUrl;
    if (task.aiModel) variables.aiModel = task.aiModel;
    if (task.aiApiKey) variables.aiApiKey = task.aiApiKey;

    const engine = new Engine({
      headless: this.options.headless ?? true,
      variables,
      // A dispatched definition carries no folder, so project-relative paths (config, invoke,
      // queue, files) resolve against the robot's own project folder.
      baseDir: this.options.baseDir ?? process.cwd(),
      onLog: (line) => this.shipLog(task.jobId, line)
    });

    const result = await engine.run(workflow, { isCancelled: () => this.isCancelled(task.flowRunId) });
    await this.finalize(task, result.status, result.error);
    this.busy = false;
    return result.status;
  }

  /**
   * Vaulted assets, fetched ONCE before the first step — the definition is logged and lingers, so a
   * secret that reaches a log line has already leaked. An unresolvable reference fails the run
   * before step 1 rather than typing an empty password and reporting Passed.
   */
  private async resolveSecrets(task: FlowTask): Promise<Record<string, unknown>> {
    const names = [...new Set([...task.definition.matchAll(/\$\{secret\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]).filter(Boolean))];
    const vars: Record<string, unknown> = {};
    for (const name of names) {
      const url = `${this.options.apiUrl.replace(/\/+$/, '')}/api/projects/${task.projectId}/assets/by-name/${encodeURIComponent(String(name))}/resolve`;
      const response = await fetch(url, { headers: { 'X-ARO-Robot-Id': this.robotId, 'X-ARO-Robot-Key': this.machineKey } });
      if (!response.ok) {
        throw new Error(`Could not resolve \${secret.${name}} (HTTP ${response.status}) — the run is refused before step 1.`);
      }
      const asset = (await response.json()) as { value?: string | null; username?: string | null };
      if (asset.value === null || asset.value === undefined) throw new Error(`\${secret.${name}} resolved to nothing; refusing to run.`);
      vars[`secret.${name}`] = asset.value;
      if (asset.username) vars[`secret.${name}.username`] = asset.username;
      console.log(`asset     : \${secret.${name}} resolved (${asset.value.length} chars, value not logged)`);
    }
    return vars;
  }

  private async shipLog(jobId: string, line: LogLine): Promise<void> {
    console.log(`  ${formatLogLine(line)}`);
    // `fields` travels in the batch as an extra key. Aro's log endpoint ignores unknown members
    // rather than refusing the batch, so a structured line is never a reason to drop a log.
    this.logs.push({
      message: line.message,
      type: line.level,
      ts: line.ts,
      ...(line.fields ? { fields: line.fields } : {})
    });
    if (this.logs.length >= 20) {
      await this.flushLogs(jobId);
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushLogs(jobId);
      }, 2000);
      this.flushTimer.unref?.();
    }
  }

  /** Ship what is buffered. A refused batch is dropped with a warning — losing log lines must never
   *  fail a flow whose steps are succeeding. */
  async flushLogs(jobId: string): Promise<void> {
    if (this.logs.length === 0) return;
    const batch = this.logs.splice(0, this.logs.length);
    try {
      const response = await fetch(`${this.base}/${this.robotId}/jobs/${jobId}/logs`, {
        method: 'POST',
        headers: this.robotHeaders,
        body: JSON.stringify({ lines: batch })
      });
      if (!response.ok) console.error(`log batch refused (HTTP ${response.status}); ${batch.length} line(s) dropped`);
    } catch (e) {
      console.error(`could not ship a log batch: ${(e as Error).message}`);
    }
  }

  private async isCancelled(flowRunId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.base}/${this.robotId}/runs/${flowRunId}/cancel`, { headers: this.robotHeaders });
      if (!response.ok) return false;
      return ((await response.json()) as { cancelRequested?: boolean }).cancelRequested === true;
    } catch {
      return false; // an unreachable orchestrator is not a stop request
    }
  }

  private async finalize(task: FlowTask, status: 'Passed' | 'Failed', error?: string): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushLogs(task.jobId);
    if (!task.finalizePath) return;
    const base = this.options.apiUrl.replace(/\/+$/, '');
    const callback = task.callbackToken ? `?callbackToken=${encodeURIComponent(task.callbackToken)}` : '';
    try {
      const response = await fetch(`${base}${task.finalizePath}${callback}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, error, robotId: this.robotId })
      });
      console.log(`finalize  : ${status} (HTTP ${response.status})`);
    } catch (e) {
      console.error(`could not report the outcome (${(e as Error).message}) — the run stays InProgress`);
    }
  }
}

export type { Step };
