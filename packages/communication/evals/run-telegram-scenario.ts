#!/usr/bin/env tsx
/**
 * Telegram behavior eval runner: drives the mock Telegram harness through a
 * scenario, captures everything Roomote posted back, and writes a
 * criterion-eval bundle for judging (see RooCodeInc/opencode-bench,
 * scripts/judge-criteria.ts).
 *
 * Prerequisites: local dev stack running (pnpm dev) with
 * TELEGRAM_API_BASE_URL pointing at the mock port used here, and the mock
 * Telegram user mapping seeded (see
 * .agents/skills/mock-telegram-testing/SKILL.md).
 *
 * Usage:
 *   pnpm --filter @roomote/communication eval:telegram-scenario -- \
 *     --scenario evals/scenarios/telegram-fast-answer.json \
 *     --webhook http://localhost:13101/api/webhooks/telegram \
 *     --target roomote@local-dev --episode 1 --out /tmp/telegram-eval-bundles
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  MockTelegramServer,
  type MockTelegramState,
} from '../src/mock-telegram-server.js';

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
      default: 'http://localhost:13101/api/webhooks/telegram',
    },
    port: { type: 'string', default: '3013' },
    target: { type: 'string', default: 'roomote@local-dev' },
    episode: { type: 'string', default: '1' },
    out: { type: 'string', default: '/tmp/telegram-eval-bundles' },
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

// Substitute run-unique tokens so episodes never collide on the Redis
// update_id dedup: every "$U<n>" becomes a unique update id and every
// "$M<n>" a unique message id — the same token maps to the same value.
// Tokens resolve to numbers when they are the entire value ("$U1"), so
// update_id/message_id fields keep their integer type.
const runBase = Math.floor(Date.now() / 10) % 100_000_000;
const tokens = new Map<string, number>();
let tokenSeq = 0;
function tokenValue(token: string): number {
  let v = tokens.get(token);
  if (v === undefined) {
    v = runBase * 100 + ++tokenSeq;
    tokens.set(token, v);
  }
  return v;
}
function substitute(value: unknown): unknown {
  if (typeof value === 'string') {
    const exact = /^\$(?:U|M)\d+$/.exec(value);
    if (exact) {
      return tokenValue(value);
    }
    return value.replace(/\$(?:U|M)\d+/g, (m) => String(tokenValue(m)));
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v)]),
    );
  }
  return value;
}

const server = new MockTelegramServer({
  state: substitute(scenario.state) as MockTelegramState,
  roomoteTarget: {
    webhookUrl: values.webhook!,
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
  },
});
const baseUrl = await server.start(Number.parseInt(values.port!, 10));
console.log(`mock telegram listening at ${baseUrl} -> ${values.webhook}`);

if (
  process.env.TELEGRAM_API_BASE_URL &&
  process.env.TELEGRAM_API_BASE_URL.replace(/\/+$/, '') !== baseUrl
) {
  console.warn(
    `WARNING: TELEGRAM_API_BASE_URL=${process.env.TELEGRAM_API_BASE_URL} does not match ${baseUrl}; ` +
      `the API server may post replies somewhere else.`,
  );
}

const startedAt = Date.now();
const dispatched: { at: string; envelope: unknown; result: unknown }[] = [];

try {
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
    const hasBotMessage = messages.some((m) => m.from.is_bot);
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
      telegram_transcript: JSON.stringify(state.messages ?? [], null, 2),
      callback_answers: JSON.stringify(state.callbackAnswers ?? [], null, 2),
      dispatched_events: JSON.stringify(dispatched, null, 2),
      timing: [
        `run started ${new Date(startedAt).toISOString()}`,
        `settled after ${Math.round(duration / 1000)}s${timedOut ? ' (TIMEOUT reached before quiescence)' : ''}`,
        `bot: ${state.bot?.username} (id ${state.bot?.id})`,
      ].join('\n'),
    },
    duration,
  };

  await mkdir(values.out!, { recursive: true });
  const outFile = join(values.out!, `${scenario.name}-ep${episode}.json`);
  await writeFile(outFile, JSON.stringify(bundle, null, 2));
  const botCount = (state.messages ?? []).filter((m) => m.from.is_bot).length;
  console.log(
    `captured ${state.messages?.length ?? 0} messages (${botCount} from bot)${timedOut ? ' [timeout]' : ''}`,
  );
  console.log(`bundle written to ${outFile}`);
} finally {
  await server.stop();
}
