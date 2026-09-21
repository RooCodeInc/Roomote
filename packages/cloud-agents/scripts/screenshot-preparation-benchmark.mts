/**
 * Controlled baseline/prototype screenshot benchmark.
 *
 * The fixture is intentionally local and deterministic. Each mode runs one
 * cold browser launch followed by warm session reuse, with the same viewport,
 * page, evidence goal, page-ready wait, DOM acceptance check, and screenshot
 * command. The final PNGs are written to BENCH_OUTPUT for visual inspection.
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
  ScreenshotPreparationInput,
  ScreenshotPreparationResponse,
} from '@roomote/types';

type PrepareScreenshotStep = (params: {
  runId: string;
  enabled: boolean;
  input: ScreenshotPreparationInput;
}) => Promise<ScreenshotPreparationResponse>;

const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'baseline';
const repetitions = Number(process.env.BENCH_REPS ?? 5);
const outputDir =
  process.env.BENCH_OUTPUT ?? '/tmp/roomote-screenshot-benchmark';
const helperPath = process.env.ROOMOTE_BENCH_HELPER;
const session = `roomote-screenshot-${mode}-${process.pid}`;
const execFileAsync = promisify(execFile);
const viewport = { width: 1280, height: 800 };
const evidenceGoal =
  "Click the observed 'Show saved profile' button, then show the saved profile state with the heading 'Profile saved' and the display name 'Roomote' visible.";
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Screenshot benchmark fixture</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #f5f7fb; color: #152033; font: 16px system-ui, sans-serif; }
      main { width: 620px; margin: 120px auto; padding: 32px; background: white; border: 1px solid #d8dfeb; border-radius: 16px; box-shadow: 0 12px 32px rgb(21 32 51 / 10%); }
      h1, h2 { margin: 0 0 12px; }
      p { margin: 8px 0; }
      button { margin-top: 20px; padding: 10px 16px; border: 0; border-radius: 8px; background: #3157d5; color: white; font: inherit; cursor: pointer; }
      #saved { margin-top: 24px; padding: 20px; border-radius: 12px; background: #eef7f1; border: 1px solid #a9d6b6; }
    </style>
  </head>
  <body>
    <main>
      <h1>Profile</h1>
      <p>Review the current profile before capturing the saved state.</p>
      <button id="show-profile">Show saved profile</button>
      <section id="saved" hidden>
        <h2>Profile saved</h2>
        <p>Display name: Roomote</p>
        <p>Plan: Pro</p>
      </section>
    </main>
    <script>
      document.querySelector('#show-profile').addEventListener('click', () => {
        document.querySelector('#saved').hidden = false;
        document.querySelector('#show-profile').remove();
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

async function readObservation(includeButton: boolean, url: string) {
  const snapshot = await browser(['snapshot', '-i']);
  const bodyText = await browser(['get', 'text', 'body']);
  const title = await browser(['get', 'title']);
  const controls: Array<Record<string, unknown>> = [];

  if (includeButton) {
    const buttonRef = snapshot.match(
      /Show saved profile.*\[ref=(e\d+)\]/u,
    )?.[1];
    if (!buttonRef) {
      throw new Error(
        'The fixture button was not present in the accessibility snapshot.',
      );
    }
    const ref = `@${buttonRef}`;
    const rect = parseBox(await browser(['get', 'box', ref, '--json']));
    controls.push({
      id: ref,
      role: 'button',
      name: 'Show saved profile',
      ...(rect ? { rect } : {}),
      visible: true,
    });
  }

  return {
    url,
    title,
    visibleText: bodyText,
    readyState: 'complete' as const,
    viewport: {
      ...viewport,
      scrollX: 0,
      scrollY: 0,
      documentWidth: viewport.width,
      documentHeight: viewport.height,
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
    await browser(['wait', '--text', 'Show saved profile']);
    const pageReadyMs = Number(
      (performance.now() - pageReadyStartedAt).toFixed(1),
    );
    const preparationStartedAt = performance.now();
    const initialObservation = await readObservation(true, url);
    const buttonId = initialObservation.controls[0]!.id as string;
    let metrics: Record<string, unknown> | null = null;
    let preparationStatus = 'baseline';

    if (mode === 'baseline') {
      await browser(['click', buttonId]);
      await browser(['wait', '--text', 'Profile saved']);
    } else {
      const runId = `screenshot-benchmark-${mode}-${index}`;
      const first = await prepareScreenshotStep!({
        runId,
        enabled: true,
        input: {
          operation: 'next',
          optIn: true,
          evidenceGoal,
          page: initialObservation,
          allowedActions: [
            { id: 'open_profile', kind: 'click', targetId: buttonId },
          ],
        } as ScreenshotPreparationInput,
      });
      if (first.status === 'running' && first.action?.kind === 'click') {
        await browser(['click', first.action.targetId]);
        await browser(['wait', '--text', 'Profile saved']);
        const readyObservation = await readObservation(false, url);
        const ready = await prepareScreenshotStep!({
          runId,
          enabled: true,
          input: {
            operation: 'next',
            optIn: true,
            loopId: first.loopId,
            evidenceGoal,
            page: readyObservation,
            allowedActions: [{ id: 'capture', kind: 'capture-ready' }],
          } as ScreenshotPreparationInput,
        });
        if (
          ready.status === 'ready' &&
          ready.action?.kind === 'capture-ready'
        ) {
          preparationStatus = 'jev-capture-ready';
          const accepted = await prepareScreenshotStep!({
            runId,
            enabled: true,
            input: {
              operation: 'record',
              optIn: true,
              loopId: first.loopId,
              outcome: 'accepted',
            } as ScreenshotPreparationInput,
          });
          metrics = accepted.metrics as unknown as Record<string, unknown>;
        } else {
          preparationStatus = `fallback-after-action:${ready.reason ?? ready.status}`;
        }
      } else {
        preparationStatus = `fallback-before-action:${first.reason ?? first.status}`;
        await browser(['click', buttonId]);
        await browser(['wait', '--text', 'Profile saved']);
      }
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
      finalText.includes('Display name: Roomote');
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
      capturePath,
      ...(metrics ? { metrics } : {}),
    });
  }
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
    acceptanceCriterion:
      "Final body text contains 'Profile saved' and 'Display name: Roomote'; exact PNGs require visual inspection.",
  },
  runs,
  summary: summarize(runs),
};
const outputPath = path.join(outputDir, `${mode}.json`);
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
