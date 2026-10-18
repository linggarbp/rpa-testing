/**
 * Project templates. `basic` is the one-workflow starter; `transactional` is a transactional
 * automation project — the Init → Get Transaction → Process → End Process loop, one file per concern
 * under `Framework/`, a local transaction queue, settings in config.json, and business vs application
 * exception handling.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Step } from './model.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export interface ScaffoldResult {
  dir: string;
  files: string[];
}

/** The starter: one workflow that opens a page, reads a heading and logs it. */
export async function scaffoldBasic(dir: string, name: string): Promise<ScaffoldResult> {
  const workflow = {
    name,
    variables: { baseUrl: 'https://example.com' },
    steps: [
      { type: 'web', action: 'goto', url: '${baseUrl}' },
      { type: 'web', action: 'getText', selector: 'h1', saveAs: 'heading' },
      { type: 'control', action: 'log', message: 'heading is ${heading}' }
    ]
  };
  await mkdir(dir, { recursive: true });
  const main = path.join(dir, 'main.json');
  await writeFile(main, json(workflow));
  await writeFile(path.join(dir, 'README.md'), `# ${name}\n\nRun it:\n\n    rpa run main.json --headed\n\nDispatch it from an Aro orchestrator:\n\n    rpa robot --api https://<aro> --project <projectId> --api-key <project API key>\n`);
  return { dir, files: ['main.json', 'README.md'] };
}

/**
 * The transactional-loop template. Every file has one job, so the flow reads top to bottom:
 *
 *   Main                     — the process loop
 *   Framework/InitAllSettings        ← Settings/Constants/Assets from Config.xlsx
 *   Framework/InitAllApplications    — open the apps the process needs
 *   Framework/GetTransactionData     — claim the next queue item
 *   Framework/Process                — the business logic (the part you write)
 *   Framework/RetryCurrentTransaction / SetTransactionStatus / TakeScreenshot / KillAllProcesses /
 *   Framework/CloseAllApplications
 */
export async function scaffoldTransactional(dir: string, name: string): Promise<ScaffoldResult> {
  const files: Record<string, string> = {};

  files['config.json'] = json({
    Config: {
      OrchestratorQueueName: 'InvoiceQueue',
      OrchestratorQueueFolder: 'Operations',
      MaxRetryNumber: '3',
      MaxConsecutiveSystemExceptions: '3',
      ProcessName: name,
      logF_BusinessProcessName: 'Framework',
      InputFolder: 'Data/Input',
      ProcessedFolder: 'Data/Processed',
      FailedFolder: 'Data/Failed'
    }
  });

  const setStatus = (status: string): Step => ({
    type: 'queue', action: 'setStatus',
    queue: '${Config.OrchestratorQueueName}',
    item: '${TransactionItem.id}',
    status,
    reason: '${exception.message}'
  });

  files['Framework/SetTransactionStatus.json'] = json({
    name: 'SetTransactionStatus',
    description: 'Close the current transaction with a status. Invoke with arguments: { "Status": "Successful" }.',
    steps: [setStatus('${Status}')]
  });

  files['Framework/TakeScreenshot.json'] = json({
    name: 'TakeScreenshot',
    description: 'Evidence on failure. Desktop screenshot (needs a GUI session); degrades to a log line where the module is missing.',
    steps: [
      {
        type: 'desktop', action: 'screenshot',
        fileName: 'exception-${TransactionItem.id}',
        path: 'Exceptions_Screenshots',
        continueOnError: true
      },
      { type: 'control', action: 'log', message: 'Exception captured for ${TransactionItem.reference} (${exception.kind})' }
    ]
  });

  files['Framework/RetryCurrentTransaction.json'] = json({
    name: 'RetryCurrentTransaction',
    description: 'Retry the transaction while MaxRetryNumber allows, else fail it as an application exception.',
    steps: [
      {
        type: 'control', action: 'if', condition: '${Config.MaxRetryNumber} == 0',
        then: [{ type: 'control', action: 'invoke', workflow: 'Framework/SetTransactionStatus.json', arguments: { Status: 'ApplicationException' } }],
        else: [
          {
            type: 'control', action: 'if', condition: '${RetryNumber} >= ${Config.MaxRetryNumber}',
            then: [{ type: 'control', action: 'invoke', workflow: 'Framework/SetTransactionStatus.json', arguments: { Status: 'ApplicationException' } }],
            else: [
              { type: 'control', action: 'math', name: 'RetryNumber', op: 'add', value: '1' },
              { type: 'queue', action: 'setStatus', queue: '${Config.OrchestratorQueueName}', item: '${TransactionItem.id}', status: 'Retry', reason: '${exception.message}' },
              { type: 'control', action: 'log', message: 'Transaction ${TransactionItem.reference} requeued (attempt ${RetryNumber}/${Config.MaxRetryNumber}).' }
            ]
          }
        ]
      }
    ]
  });

  files['Framework/InitAllSettings.json'] = json({
    name: 'InitAllSettings',
    description: 'Load config.json (the Config.xlsx equivalent) into ${Config.*}, then apply framework defaults.',
    steps: [
      { type: 'config', action: 'load', path: 'config.json' },
      {
        type: 'control', action: 'if', condition: '${Config.MaxRetryNumber} == ',
        then: [{ type: 'control', action: 'setVar', name: 'Config.MaxRetryNumber', value: '3' }]
      },
      { type: 'control', action: 'setVar', name: 'RetryNumber', value: '0' },
      { type: 'control', action: 'log', message: 'Settings loaded — queue "${Config.OrchestratorQueueName}" (folder ${Config.OrchestratorQueueFolder}), maxRetry=${Config.MaxRetryNumber}' }
    ]
  });

  files['Framework/InitAllApplications.json'] = json({
    name: 'InitAllApplications',
    description: 'Open everything the process needs. Add web/desktop steps here; the browser stays open for the whole run.',
    steps: [
      { type: 'control', action: 'log', message: 'InitAllApplications: nothing to open yet — add the apps this process drives.' }
    ]
  });

  files['Framework/GetTransactionData.json'] = json({
    name: 'GetTransactionData',
    description: 'Claim the next transaction from the queue. Sets ${TransactionItem} (empty string = nothing left) plus ${TransactionItem.id|reference|retries|<data fields>}.',
    steps: [
      { type: 'queue', action: 'getTransactionItem', queue: '${Config.OrchestratorQueueName}', saveAs: 'TransactionItem' },
      {
        type: 'control', action: 'if', condition: '${TransactionItem} == ',
        then: [{ type: 'control', action: 'log', message: 'No more transactions in "${Config.OrchestratorQueueName}".' }],
        else: [
          // A retried item keeps its counter; only a fresh one restarts it. (The shipped template
          // initialises RetryNumber once per run instead — a quirk the port deliberately fixes.)
          {
            type: 'control', action: 'if', condition: '${TransactionItem.retries} == 0',
            then: [{ type: 'control', action: 'setVar', name: 'RetryNumber', value: '0' }]
          },
          { type: 'control', action: 'log', message: 'Transaction ${TransactionItem.reference} claimed (${TransactionItem.id}).' }
        ]
      }
    ]
  });

  files['Framework/Process.json'] = json({
    name: 'Process',
    description: 'THE BUSINESS LOGIC. This is the only file a real robot should need to rewrite. Throw with kind "business" for rule violations (no retry) and "application" for failures a retry could fix.',
    steps: [
      { type: 'control', action: 'log', message: 'Processing ${TransactionItem.reference} (attempt ${RetryNumber}) with data ${TransactionItem.data}' },
      {
        type: 'control', action: 'if', condition: '${TransactionItem.reference} == fail-me',
        then: [{ type: 'control', action: 'throw', kind: 'business', message: 'Reference "fail-me" violates a business rule; no retry will help.' }]
      },
      { type: 'control', action: 'log', message: 'TODO: replace this stub with the robot real work (open the invoice, read it, write the result).' }
    ]
  });

  files['Framework/KillAllProcesses.json'] = json({
    name: 'KillAllProcesses',
    description: 'Hard stop of the apps this process opens. Nothing to kill in the template — add desktop/pkill steps for a real robot.',
    steps: [{ type: 'control', action: 'log', message: 'KillAllProcesses: no managed processes registered.' }]
  });

  files['Framework/CloseAllApplications.json'] = json({
    name: 'CloseAllApplications',
    description: 'Graceful shutdown, always runs (the framework finally block). The run closes the browser itself at the end.',
    steps: [{ type: 'control', action: 'log', message: 'CloseAllApplications: done.' }]
  });

  files['Data/Queue/.gitkeep'] = '';
  files['Data/Input/.gitkeep'] = '';
  files['Data/Processed/.gitkeep'] = '';
  files['Data/Failed/.gitkeep'] = '';
  files['Exceptions_Screenshots/.gitkeep'] = '';

  files['README.md'] = `# ${name} — transactional loop

A transactional automation project: Init → Get Transaction Data → Process → End Process,
with one file per concern under \`Framework/\`.

## The loop

    Main.json
      try
        InitAllSettings       ← config.json → \${Config.*}
        InitAllApplications   ← open the apps
        while continueProcessing
          GetTransactionData  ← queue.getTransactionItem → \${TransactionItem}
          try   Process → setStatus Successful
          catch business       → screenshot + setStatus BusinessException   (no retry)
          catch application    → screenshot + RetryCurrentTransaction      (retry, else ApplicationException)
      finally
        CloseAllApplications

## Run it

    rpa run Main.json

## Fill the queue (the dispatcher side)

    rpa queue add --project . InvoiceQueue "INV-001" '{"amount":"120.00"}'
    # or from a workflow: {"type":"queue","action":"addItem","queue":"InvoiceQueue","reference":"INV-001","data":{"amount":"120.00"}}

The queue lives in \`.rpa/queues/<queue>.jsonl\` beside this file: New → InProgress →
Successful | BusinessException | ApplicationException, and \`Retry\` returns an item to New with its
retry count bumped.

## Design notes

- The loop is a \`while\` with explicit transitions rather than a state diagram — same behaviour, one readable file.
- The queue is a local file store, so a dispatcher and a performer can share a folder or a mounted drive without a server.
- Settings are config.json (CSV and XLSX are read too, when \`exceljs\` is installed).
- Expressions are explicit steps (\`math\`, \`if\`, comparisons with &gt;= &lt;) — no expression language, no eval.
`;

  files['Main.json'] = json({
    name: 'Main',
    description: 'Transactional loop: Init → Get Transaction Data → Process → End Process.',
    steps: [
      { type: 'control', action: 'setVar', name: 'continueProcessing', value: 'true' },
      { type: 'control', action: 'setVar', name: 'TransactionNumber', value: '0' },
      { type: 'control', action: 'setVar', name: 'ConsecutiveSystemExceptions', value: '0' },
      {
        type: 'control', action: 'try',
        body: [
          { type: 'control', action: 'invoke', workflow: 'Framework/InitAllSettings.json' },
          { type: 'control', action: 'invoke', workflow: 'Framework/InitAllApplications.json' },
          {
            type: 'control', action: 'while', condition: '${continueProcessing} == true', maxIterations: 1000,
            steps: [
              { type: 'control', action: 'invoke', workflow: 'Framework/GetTransactionData.json' },
              {
                type: 'control', action: 'if', condition: '${TransactionItem} == ',
                then: [{ type: 'control', action: 'setVar', name: 'continueProcessing', value: 'false' }],
                else: [
                  { type: 'control', action: 'math', name: 'TransactionNumber', op: 'add', value: '1' },
                  {
                    type: 'control', action: 'try',
                    body: [
                      { type: 'control', action: 'invoke', workflow: 'Framework/Process.json' },
                      { type: 'control', action: 'invoke', workflow: 'Framework/SetTransactionStatus.json', arguments: { Status: 'Successful' } }
                    ],
                    catches: [
                      {
                        kind: 'business',
                        steps: [
                          { type: 'control', action: 'invoke', workflow: 'Framework/TakeScreenshot.json' },
                          { type: 'control', action: 'invoke', workflow: 'Framework/SetTransactionStatus.json', arguments: { Status: 'BusinessException' } },
                          { type: 'control', action: 'log', message: 'Business exception on ${TransactionItem.reference}: ${exception.message}' }
                        ]
                      },
                      {
                        kind: 'application',
                        steps: [
                          { type: 'control', action: 'invoke', workflow: 'Framework/TakeScreenshot.json' },
                          { type: 'control', action: 'invoke', workflow: 'Framework/RetryCurrentTransaction.json' },
                          { type: 'control', action: 'math', name: 'ConsecutiveSystemExceptions', op: 'add', value: '1' }
                        ]
                      }
                    ],
                    finally: [{ type: 'control', action: 'log', message: 'Transaction ${TransactionNumber} finished: ${TransactionItem.reference}' }]
                  }
                ]
              }
            ]
          }
        ],
        catches: [
          {
            kind: 'any',
            steps: [
              { type: 'control', action: 'invoke', workflow: 'Framework/TakeScreenshot.json' },
              { type: 'control', action: 'log', message: 'Framework stopped: ${exception.message} (${exception.kind})' }
            ]
          }
        ],
        finally: [{ type: 'control', action: 'invoke', workflow: 'Framework/CloseAllApplications.json' }]
      }
    ]
  });

  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { dir, files: Object.keys(files).sort() };
}
