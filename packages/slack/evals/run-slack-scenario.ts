#!/usr/bin/env tsx
/**
 * Slack behavior eval runner: drives the mock Slack harness through a
 * scenario, captures everything Roomote posted back, and writes a
 * criterion-eval bundle for judging (see RooCodeInc/opencode-bench,
 * scripts/judge-criteria.ts).
 *
 * Prerequisites: local dev stack running (pnpm dev) with
 * SLACK_API_BASE_URL pointing at the mock port used here, and the mock
 * Slack installation/user mapping seeded (see
 * .claude/skills/mock-slack-testing/SKILL.md).
 *
 * Usage:
 *   pnpm --filter @roomote/slack eval:scenario -- \
 *     --scenario evals/scenarios/slack-fast-answer.json \
 *     --webhook http://localhost:13101/api/webhooks/slack \
 *     --target roomote@local-dev --episode 1 --out /tmp/slack-eval-bundles
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MockSlackServer,
  type MockSlackState,
} from '../src/mock-slack-server.js';

const scenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string(),
  criteria: z.array(z.string().min(1)).min(1),
  state: z.record(z.string(), z.unknown()),
  events: z.array(
    z.object({
      delayMs: z.number().int().nonnegative().default(0),
      envelope: z.record(z.string(), z.unknown()),
    }),
  ),
  settleMs: z.number().int().positive().default(20_000),
  timeoutMs: z.number().int().positive().default(180_000),
});

const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    webhook: {
      type: 'string',
      default: 'http://localhost:13101/api/webhooks/slack',
    },
    port: { type: 'string', default: '3012' },
    target: { type: 'string', default: 'roomote@local-dev' },
    episode: { type: 'string', default: '1' },
    out: { type: 'string', default: '/tmp/slack-eval-bundles' },
  },
});

if (!values.scenario) {
  console.error('Error: --scenario <file> is required');
  process.exit(1);
}

const scenario = scenarioSchema.parse(
  JSON.parse(await readFile(values.scenario, 'utf-8')),
);
const episode = Number.parseInt(values.episode!, 10) || 1;

// Substitute run-unique tokens so episodes never collide on Slack event
// dedup or thread locks: every "$E<n>" becomes a unique event id and every
// "$TS<n>" a unique Slack timestamp — the same token maps to the same value.
const runId = `${Date.now().toString(36)}-ep${episode}`;
const tokens = new Map<string, string>();
let tsSeq = 0;
function tokenValue(token: string): string {
  let v = tokens.get(token);
  if (!v) {
    v = token.startsWith('$TS')
      ? `${Math.floor(Date.now() / 1000)}.${String(100000 + ++tsSeq)}`
      : `evt-${runId}-${token.slice(2).toLowerCase()}`;
    tokens.set(token, v);
  }
  return v;
}
function substitute(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$(?:TS|E)\d+/g, (m) => tokenValue(m));
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v)]),
    );
  }
  return value;
}

const server = new MockSlackServer({
  state: substitute(scenario.state) as MockSlackState,
  roomoteTarget: {
    webhookUrl: values.webhook!,
    signingSecret: process.env.R_SLACK_SIGNING_SECRET ?? '',
  },
});
const baseUrl = await server.start(Number.parseInt(values.port!, 10));
console.log(`mock slack listening at ${baseUrl} -> ${values.webhook}`);

const expectedBase = `${baseUrl}/api/`;
if (
  process.env.SLACK_API_BASE_URL &&
  process.env.SLACK_API_BASE_URL !== expectedBase
) {
  console.warn(
    `WARNING: SLACK_API_BASE_URL=${process.env.SLACK_API_BASE_URL} does not match ${expectedBase}; ` +
      `the API server may post replies somewhere else.`,
  );
}

const startedAt = Date.now();
const dispatched: { at: string; envelope: unknown; result: unknown }[] = [];

try {
  // Preflight: the webhook must answer a url_verification handshake.
  const handshake = await server.dispatch({
    kind: 'url_verification',
    challenge: `preflight-${runId}`,
  } as never);
  if (handshake.status !== 200) {
    throw new Error(
      `Webhook preflight failed: HTTP ${handshake.status} from ${values.webhook}`,
    );
  }

  for (const { delayMs, envelope } of scenario.events) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const resolved = substitute(envelope);
    const result = await server.dispatch(resolved as never);
    dispatched.push({
      at: new Date().toISOString(),
      envelope: resolved,
      result,
    });
    console.log(
      `dispatched ${(resolved as { kind: string }).kind} -> HTTP ${result.status}`,
    );
  }

  // Settle: wait until the message log has been stable for settleMs (with
  // at least one bot message), or give up at timeoutMs and judge as-is.
  let lastCount = -1;
  let stableSince = Date.now();
  let timedOut = false;
  for (;;) {
    const messages = server.getState().messages ?? [];
    if (messages.length !== lastCount) {
      lastCount = messages.length;
      stableSince = Date.now();
    }
    const hasBotMessage = messages.some((m) => m.bot_id);
    if (hasBotMessage && Date.now() - stableSince >= scenario.settleMs) break;
    if (Date.now() - startedAt >= scenario.timeoutMs) {
      timedOut = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const duration = Date.now() - startedAt;
  const state = server.getState();
  const bundle = {
    name: scenario.name,
    target: values.target,
    episode,
    criteria: scenario.criteria,
    artifacts: {
      slack_transcript: JSON.stringify(state.messages ?? [], null, 2),
      dispatched_events: JSON.stringify(dispatched, null, 2),
      timing: [
        `run started ${new Date(startedAt).toISOString()}`,
        `settled after ${Math.round(duration / 1000)}s${timedOut ? ' (TIMEOUT reached before quiescence)' : ''}`,
        `bot user id: ${state.botUserId}, bot id: ${state.botId}`,
      ].join('\n'),
    },
    duration,
  };

  await mkdir(values.out!, { recursive: true });
  const outFile = join(values.out!, `${scenario.name}-ep${episode}.json`);
  await writeFile(outFile, JSON.stringify(bundle, null, 2));
  const botCount = (state.messages ?? []).filter((m) => m.bot_id).length;
  console.log(
    `captured ${state.messages?.length ?? 0} messages (${botCount} from bot)${timedOut ? ' [timeout]' : ''}`,
  );
  console.log(`bundle written to ${outFile}`);
} finally {
  await server.stop();
}
