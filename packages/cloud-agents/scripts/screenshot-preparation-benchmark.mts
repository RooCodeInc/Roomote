/**
 * Controlled baseline/prototype screenshot benchmark.
 *
 * The fixture is local and deterministic. Each run uses the same 1280x800
 * viewport, evidence goal, page-ready wait, acceptance criterion, one cold
 * browser launch plus warm session reuse, and exact final PNG inspection.
 * The complex scenario requires a settings-tab click, form fill, review dialog,
 * below-fold scroll, and final save action. Prototype mode requires every
 * preparation action to be returned by Jev; a fallback makes the comparison
 * invalid instead of being reported as a Jev success.
 *
 * Baseline:
 *   pnpm --filter @roomote/cloud-agents benchmark:screenshot-preparation -- --mode baseline
 *
 * Prototype (uses an already configured server-side judgment credential; no
 * credential is passed to this script):
 *   NODE_ENV=development R_JUDGMENT_MODEL=openrouter \
 *   ROOMOTE_BENCH_HELPER="$PWD/src/server/screenshot-preparation.ts" \
 *   pnpm exec dotenvx run --quiet -f .env.local -- \
 *   pnpm --filter @roomote/cloud-agents benchmark:screenshot-preparation -- --mode prototype
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  ScreenshotPreparationAction,
  ScreenshotPreparationInput,
  ScreenshotPreparationResponse,
} from '@roomote/types';

type PrepareScreenshotStep = (params: {
  runId: string;
  enabled: boolean;
  input: ScreenshotPreparationInput;
}) => Promise<ScreenshotPreparationResponse>;

type Target = {
  label: string;
  role: string;
};

const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'baseline';
const repetitions = Number(process.env.BENCH_REPS ?? 5);
const outputDir =
  process.env.BENCH_OUTPUT ?? '/tmp/roomote-screenshot-benchmark';
const helperPath = process.env.ROOMOTE_BENCH_HELPER;
const session = `ssb-${mode === 'prototype' ? 'p' : 'b'}-${process.pid}`;
const execFileAsync = promisify(execFile);
const viewport = { width: 1280, height: 800 };
const evidenceGoal =
  "Open Settings, enter the display name 'Roomote', review the changes, scroll to the below-fold Security checks section, and save. The final screenshot must show Profile saved, Display name: Roomote, and Security checks complete.";
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Screenshot benchmark fixture</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 1800px; background: #f5f7fb; color: #152033; font: 16px system-ui, sans-serif; }
      main { width: 700px; margin: 70px auto; padding: 32px; background: white; border: 1px solid #d8dfeb; border-radius: 16px; box-shadow: 0 12px 32px rgb(21 32 51 / 10%); }
      nav { display: flex; gap: 8px; margin-bottom: 26px; }
      nav button, button { padding: 10px 16px; border: 0; border-radius: 8px; background: #3157d5; color: white; font: inherit; cursor: pointer; }
      nav button[aria-selected="true"] { background: #162b70; }
      h1, h2 { margin: 0 0 12px; }
      p { margin: 8px 0; }
      label { display: block; margin-top: 20px; font-weight: 650; }
      input { display: block; width: 100%; margin-top: 8px; padding: 10px; border: 1px solid #aab5c8; border-radius: 8px; font: inherit; }
      #settings-panel[hidden], #overview-panel[hidden], #review-dialog[hidden], #success[hidden] { display: none; }
      #review-dialog { margin-top: 24px; padding: 20px; border: 1px solid #b9c8e7; border-radius: 12px; background: #f3f6ff; }
      #security { margin-top: 720px; padding: 24px; border-radius: 12px; background: #fff7e8; border: 1px solid #e3c98e; }
      #success { padding: 24px; border-radius: 12px; background: #eef7f1; border: 1px solid #a9d6b6; }
    </style>
  </head>
  <body>
    <main>
      <nav role="tablist" aria-label="Profile sections">
        <button id="overview-tab" role="tab" aria-selected="true">Overview</button>
        <button id="settings-tab" role="tab" aria-selected="false">Settings</button>
      </nav>
      <section id="overview-panel">
        <h1>Profile overview</h1>
        <p>Choose Settings to edit the profile.</p>
      </section>
      <section id="settings-panel" hidden>
        <h1>Profile settings</h1>
        <p>Update the profile and complete the security check before saving.</p>
        <label for="display-name">Display name</label>
        <input id="display-name" type="text" value="" />
        <button id="review-button">Review changes</button>
        <div id="review-dialog" role="dialog" aria-label="Review changes" hidden>
          <h2>Review changes</h2>
          <p>Confirm the profile update after checking the security section below.</p>
          <button id="save-button">Save profile</button>
        </div>
        <section id="security">
          <h2>Security checks</h2>
          <p>Below-fold security verification is complete for this fixture.</p>
        </section>
      </section>
      <section id="success" hidden>
        <h1>Profile saved</h1>
        <p>Display name: Roomote</p>
        <h2>Security checks complete</h2>
        <p>The profile is ready for the screenshot.</p>
      </section>
    </main>
    <script>
      const overviewTab = document.querySelector('#overview-tab');
      const settingsTab = document.querySelector('#settings-tab');
      const overviewPanel = document.querySelector('#overview-panel');
      const settingsPanel = document.querySelector('#settings-panel');
      const reviewButton = document.querySelector('#review-button');
      const reviewDialog = document.querySelector('#review-dialog');
      const saveButton = document.querySelector('#save-button');
      const displayName = document.querySelector('#display-name');
      const success = document.querySelector('#success');
      settingsTab.addEventListener('click', () => {
        overviewTab.setAttribute('aria-selected', 'false');
        settingsTab.setAttribute('aria-selected', 'true');
        overviewPanel.hidden = true;
        settingsPanel.hidden = false;
      });
      overviewTab.addEventListener('click', () => {
        overviewTab.setAttribute('aria-selected', 'true');
        settingsTab.setAttribute('aria-selected', 'false');
        overviewPanel.hidden = false;
        settingsPanel.hidden = true;
      });
      reviewButton.addEventListener('click', () => {
        reviewDialog.hidden = false;
      });
      saveButton.addEventListener('click', () => {
        if (displayName.value !== 'Roomote') return;
        settingsPanel.hidden = true;
        success.hidden = false;
        window.scrollTo(0, 0);
      });
    </script>
  </body>
</html>`;

async function browser(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'agent-browser',
    ['--session', session, ...args],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 },
  );
  return stdout.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function findRef(snapshot: string, label: string): string | undefined {
  const escaped = escapeRegExp(label);
  const prefix = snapshot.match(
    new RegExp(`(@e\\d+)[^\\n]*${escaped}`, 'u'),
  )?.[1];
  if (prefix) return prefix;
  const trailing = snapshot.match(
    new RegExp(`${escaped}[^\\n]*\\[ref=(e\\d+)\\]`, 'u'),
  )?.[1];
  return trailing ? `@${trailing}` : undefined;
}

function parseBox(
  value: string,
): { x: number; y: number; width: number; height: number } | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const candidate = (parsed.data ?? parsed) as Record<string, unknown>;
    if (
      typeof candidate.x === 'number' &&
      typeof candidate.y === 'number' &&
      typeof candidate.width === 'number' &&
      typeof candidate.height === 'number'
    ) {
      return {
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readGeometry() {
  try {
    return JSON.parse(
      await browser([
        'eval',
        'JSON.stringify({scrollX:window.scrollX,scrollY:window.scrollY,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight})',
      ]),
    ) as {
      scrollX: number;
      scrollY: number;
      documentWidth: number;
      documentHeight: number;
    };
  } catch {
    return {
      scrollX: 0,
      scrollY: 0,
      documentWidth: viewport.width,
      documentHeight: viewport.height,
    };
  }
}

async function readObservation(target?: Target, url?: string) {
  const snapshot = await browser(['snapshot', '-i']);
  const bodyText = await browser(['get', 'text', 'body']);
  const title = await browser(['get', 'title']);
  const geometry = await readGeometry();
  const controls: Array<Record<string, unknown>> = [];

  if (target) {
    const ref = findRef(snapshot, target.label);
    if (!ref) {
      throw new Error(
        `The fixture target was not present in the snapshot: ${target.label}`,
      );
    }
    const rect = parseBox(await browser(['get', 'box', ref, '--json']));
    controls.push({
      id: ref,
      role: target.role,
      name: target.label,
      ...(rect ? { rect } : {}),
      visible: true,
    });
  }

  return {
    url: url ?? (await browser(['get', 'url'])),
    title,
    visibleText: bodyText,
    readyState: 'complete' as const,
    viewport: {
      width: viewport.width,
      height: viewport.height,
      ...geometry,
    },
    controls,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function summarize(runs: Array<Record<string, unknown>>) {
  const numeric = (key: string, selected: Array<Record<string, unknown>>) => {
    const values = selected
      .map((run) => run[key])
      .filter((value): value is number => typeof value === 'number');
    return values.length > 0
      ? {
          median: median(values),
          min: Math.min(...values),
          max: Math.max(...values),
        }
      : null;
  };
  const cold = runs.filter((run) => run.coldStartMs !== null);
  const warm = runs.filter((run) => run.coldStartMs === null);
  return {
    cold: {
      count: cold.length,
      pageReadyMs: numeric('pageReadyMs', cold),
      preparationMs: numeric('preparationMs', cold),
      captureMs: numeric('captureMs', cold),
      totalMs: numeric('totalMs', cold),
    },
    warm: {
      count: warm.length,
      pageReadyMs: numeric('pageReadyMs', warm),
      preparationMs: numeric('preparationMs', warm),
      captureMs: numeric('captureMs', warm),
      totalMs: numeric('totalMs', warm),
    },
  };
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Could not resolve fixture server address.');
}
const url = `http://127.0.0.1:${address.port}/fixture`;
mkdirSync(outputDir, { recursive: true });

let prepareScreenshotStep: PrepareScreenshotStep | undefined;
if (mode === 'prototype') {
  if (!helperPath) {
    throw new Error('ROOMOTE_BENCH_HELPER is required for prototype mode.');
  }
  ({ prepareScreenshotStep } = (await import(helperPath)) as {
    prepareScreenshotStep: PrepareScreenshotStep;
  });
}

const runs: Array<Record<string, unknown>> = [];
let failedMetrics: Record<string, unknown> | null = null;
const actionPlan: Array<{
  target?: Target;
  action: ScreenshotPreparationAction;
  stepGoal: string;
  waitFor?: string;
}> = [
  {
    target: { label: 'Settings', role: 'button' },
    action: { id: 'select_settings_tab', kind: 'click', targetId: '' },
    stepGoal: 'Select the Settings tab now.',
    waitFor: 'Profile settings',
  },
  {
    target: { label: 'Display name', role: 'textbox' },
    action: {
      id: 'fill_display_name',
      kind: 'fill',
      targetId: '',
      value: 'Roomote',
    },
    stepGoal: "Fill the Display name field with 'Roomote' now.",
  },
  {
    target: { label: 'Review changes', role: 'button' },
    action: { id: 'open_review_dialog', kind: 'click', targetId: '' },
    stepGoal: 'Open the Review changes dialog now.',
    waitFor: 'Review changes',
  },
  {
    target: { label: 'Save profile', role: 'button' },
    action: {
      id: 'scroll_to_security',
      kind: 'scroll',
      direction: 'down',
      amount: 700,
    },
    stepGoal:
      'Scroll down 700 pixels now; Security checks is below the fold and the current scroll position is 0.',
    waitFor: 'Security checks',
  },
  {
    target: { label: 'Save profile', role: 'button' },
    action: { id: 'save_profile', kind: 'click', targetId: '' },
    stepGoal:
      'Click the visible Save profile button in the Review changes dialog now; the display name is Roomote and Security checks is visible.',
    waitFor: 'Profile saved',
  },
];

try {
  for (let index = 0; index < repetitions; index += 1) {
    const runStartedAt = performance.now();
    const pageReadyStartedAt = performance.now();
    await browser([
      'set',
      'viewport',
      String(viewport.width),
      String(viewport.height),
    ]);
    await browser(['open', url]);
    await browser(['wait', '--load', 'networkidle']);
    await browser(['wait', '--text', 'Profile overview']);
    const pageReadyMs = Number(
      (performance.now() - pageReadyStartedAt).toFixed(1),
    );
    const preparationStartedAt = performance.now();
    let metrics: Record<string, unknown> | null = null;
    let preparationStatus = mode === 'baseline' ? 'baseline' : 'jev-guided';
    let jevActionCount = 0;
    let fallbackCount = 0;
    let loopId: string | undefined;

    for (const plan of actionPlan) {
      const observation = await readObservation(plan.target, url);
      const ref = observation.controls[0]?.id as string | undefined;
      const action = plan.target
        ? { ...plan.action, targetId: ref ?? '' }
        : plan.action;
      if (action.kind === 'click' || action.kind === 'fill') {
        if (!action.targetId) throw new Error(`No target ref for ${action.id}`);
      }

      if (mode === 'baseline') {
        if (action.kind === 'scroll') {
          await browser(['scroll', action.direction, String(action.amount)]);
        } else if (action.kind === 'click') {
          await browser(['click', action.targetId]);
        } else if (action.kind === 'fill') {
          await browser(['fill', action.targetId, action.value]);
        }
      } else {
        const decision = await prepareScreenshotStep!({
          runId: `complex-screenshot-benchmark-${mode}-${index}`,
          enabled: true,
          input: {
            operation: 'next',
            optIn: true,
            ...(loopId ? { loopId } : {}),
            evidenceGoal: plan.stepGoal,
            page: observation,
            allowedActions: [action],
          } as ScreenshotPreparationInput,
        });
        if (decision.status !== 'running' || !decision.action) {
          fallbackCount += 1;
          metrics = decision.metrics as unknown as Record<string, unknown>;
          failedMetrics = metrics;
          preparationStatus = `fallback:${plan.action.id}:${decision.reason ?? decision.status}`;
          throw new Error(preparationStatus);
        }
        jevActionCount += 1;
        loopId = decision.loopId;
        const selected = decision.action;
        if (selected.kind === 'scroll') {
          await browser([
            'scroll',
            selected.direction,
            String(selected.amount),
          ]);
        } else if (selected.kind === 'click') {
          await browser(['click', selected.targetId]);
        } else if (selected.kind === 'fill') {
          await browser(['fill', selected.targetId, selected.value]);
        }
        metrics = decision.metrics as unknown as Record<string, unknown>;
      }

      if (plan.waitFor) await browser(['wait', '--text', plan.waitFor]);
    }

    const preparationMs = Number(
      (performance.now() - preparationStartedAt).toFixed(1),
    );
    const capturePath = path.join(outputDir, `${mode}-${index + 1}.png`);
    const captureStartedAt = performance.now();
    await browser(['screenshot', capturePath]);
    const captureMs = Number((performance.now() - captureStartedAt).toFixed(1));
    const finalText = await browser(['get', 'text', 'body']);
    const accepted =
      finalText.includes('Profile saved') &&
      finalText.includes('Display name: Roomote') &&
      finalText.includes('Security checks complete');
    let recordStatus: string | null = null;
    if (mode === 'prototype' && preparationStatus === 'jev-guided' && loopId) {
      if (!accepted) {
        throw new Error('visual_acceptance_failed');
      }
      const recorded = await prepareScreenshotStep!({
        runId: `complex-screenshot-benchmark-${mode}-${index}`,
        enabled: true,
        input: {
          operation: 'record',
          optIn: true,
          loopId,
          outcome: 'accepted',
        } as ScreenshotPreparationInput,
      });
      recordStatus = recorded.status;
      metrics = recorded.metrics as unknown as Record<string, unknown>;
      if (recorded.status !== 'accepted') {
        throw new Error(`record_failed:${recorded.reason ?? recorded.status}`);
      }
    }
    runs.push({
      mode,
      run: index + 1,
      coldStartMs: index === 0 ? pageReadyMs : null,
      pageReadyMs,
      preparationMs,
      captureMs,
      totalMs: Number((performance.now() - runStartedAt).toFixed(1)),
      accepted,
      preparationStatus,
      ...(recordStatus ? { recordStatus } : {}),
      jevActionCount,
      fallbackCount,
      capturePath,
      ...(metrics ? { metrics } : {}),
    });
  }
} catch (error) {
  runs.push({
    mode,
    run: runs.length + 1,
    accepted: false,
    preparationStatus: error instanceof Error ? error.message : String(error),
    ...(failedMetrics ? { metrics: failedMetrics } : {}),
  });
} finally {
  try {
    await browser(['close']);
  } catch {
    // The benchmark result is more useful than a cleanup failure.
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const result = {
  mode,
  fixture: {
    url,
    viewport,
    evidenceGoal,
    repetitions,
    warmupPolicy:
      'run 1 launches the browser; subsequent runs reuse the named session and reopen the same fixture before each attempt',
    actionPlan: actionPlan.map((plan) => plan.action.id),
    acceptanceCriterion:
      "Final body text contains 'Profile saved', 'Display name: Roomote', and 'Security checks complete'; exact PNGs require visual inspection.",
  },
  runs,
  summary: summarize(runs),
};
const outputPath = path.join(outputDir, `${mode}.json`);
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(runs.some((run) => run.accepted === false) ? 2 : 0);
