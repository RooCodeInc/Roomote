// Runs against the deployed candidate, not a component fixture. Authentication
// uses a short-lived synthetic session seeded only in the disposable CI DB.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const url = new URL(process.env.MODEL_SETTINGS_SMOKE_URL);
assert(
  ['127.0.0.1', 'localhost'].includes(url.hostname),
  'CI browser requires loopback',
);
const token = process.env.MODEL_SETTINGS_SMOKE_SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET || process.env.ENCRYPTION_KEY;
assert(token && secret, 'CI session and signing key are required');
const directory = mkdtempSync(join(tmpdir(), 'model-settings-browser-'));
const statePath = join(directory, 'state.json');
const session = `model-settings-ci-${process.pid}`;
const signature = createHmac('sha256', secret).update(token).digest('base64');
writeFileSync(
  statePath,
  JSON.stringify({
    cookies: [
      {
        name: 'better-auth.session_token',
        value: encodeURIComponent(`${token}.${signature}`),
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ],
    origins: [],
  }),
  { mode: 0o600 },
);

function browser(...args) {
  return execFileSync('agent-browser', ['--session', session, ...args], {
    encoding: 'utf8',
    timeout: 90_000,
  });
}

async function waitForServer(predicate, description) {
  // agent-browser's wait --fn treats a Promise as truthy before it resolves;
  // evaluate (which awaits it) and poll in Node to require a persisted save.
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = JSON.parse(
      browser(
        'eval',
        '--json',
        `fetch('/api/trpc/taskModels.get?input=%7B%22json%22%3Anull%7D').then(r => r.json()).then(r => {
      const s = r.result?.data?.json;
      return Boolean(s && (${predicate}));
    }).catch(() => false)`,
      ),
    );
    if (response.data?.result === true) return;
    await setTimeout(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  browser('--state', statePath, 'open', new URL('/settings/models', url).href);
  browser('wait', '--load', 'networkidle');
  browser('wait', '--text', 'Use a mapping preset');
  browser(
    'wait',
    '--fn',
    `Boolean(document.querySelector('button[aria-label="Coding model and reasoning"]')?.textContent.includes('GPT 5.4'))`,
  );
  browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    'Use a mapping preset',
    '--exact',
  );
  browser('wait', '--text', 'Upgrade legacy mapping');
  browser(
    'find',
    'role',
    'button',
    'click',
    '--name',
    'Custom preset: Upgrade legacy mapping',
    '--exact',
  );
  browser('wait', '--text', 'Apply Upgrade legacy mapping preset');
  browser(
    'wait',
    '--fn',
    'document.getAnimations().every(animation => animation.playState !== "running")',
  );
  assert(!browser('snapshot').includes('Missing or invalid selection'));
  const preview = browser('snapshot', '-i');
  const applyRef = preview.match(/button "Apply" \[ref=(e\d+)\]/)?.[1];
  assert(applyRef, 'The legacy preset must have an enabled Apply button');
  browser('click', `@${applyRef}`);
  // Observe real server state after autosave, not just an optimistic toast.
  await waitForServer(
    `s.defaultModelId === 'openrouter/openai/gpt-5.4'
    && s.runtimeModels.audioVideoModel.persistedModelId === 'openrouter/openai/gpt-5.4'
    && s.runtimeModels.codingModel.reasoningEffort === 'high'
    && s.runtimeModels.audioVideoModel.reasoningEffort === 'high'
    && s.runtimeModels.visionModel.persistedModelId === 'openrouter/z-ai/glm-5.2'
    && s.modelFallbacks.enabled === true`,
    'the applied legacy mapping to be saved',
  );
  browser('reload');
  browser('wait', '--load', 'networkidle');
  browser(
    'wait',
    '--fn',
    `Boolean(document.querySelector('button[aria-label="Audio and video model and reasoning"]')?.textContent.includes('GPT 5.4'))`,
  );
  browser('click', '[role="switch"][aria-label="Fallback config"]');
  await waitForServer(
    's.modelFallbacks.enabled === false',
    'disabled backups to be saved',
  );
  browser('reload');
  browser('wait', '--load', 'networkidle');
  browser(
    'wait',
    '--fn',
    `document.querySelector('[role="switch"][aria-label="Fallback config"]')?.getAttribute('aria-checked') === 'false'`,
  );
  browser('click', '[role="switch"][aria-label="Fallback config"]');
  await waitForServer(
    's.modelFallbacks.enabled === true',
    'enabled backups to be restored',
  );
  assert(!browser('errors').trim(), 'Unexpected uncaught browser errors');
  console.log(
    'Populated model settings: load, menu, preview, apply, persisted save, reload and backups enabled/disabled passed.',
  );
} catch (error) {
  console.error(browser('snapshot', '-i'));
  console.error(browser('errors'));
  throw error;
} finally {
  try {
    browser('close');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
