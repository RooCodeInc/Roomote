#!/usr/bin/env tsx
/**
 * Discord behavior eval runner: drives the mock Discord harness through a
 * scenario, captures everything Roomote posted back, and writes a
 * criterion-eval bundle for judging (see RooCodeInc/opencode-bench,
 * scripts/judge-criteria.ts).
 *
 * Prerequisites: local dev stack running (pnpm dev) with
 * DISCORD_API_BASE_URL pointing at the mock port used here, and the mock
 * Discord user mapping seeded (see
 * .agents/skills/mock-discord-testing/SKILL.md).
 *
 * Usage:
 *   pnpm --filter @roomote/communication eval:discord-scenario -- \
 *     --scenario evals/scenarios/discord-fast-answer.json \
 *     --events http://localhost:13101/api/internal/discord/events \
 *     --target roomote@local-dev --episode 1 --out /tmp/discord-eval-bundles
 */

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MockDiscordServer } from '../src/mock-discord-server.js';

const scenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string(),
  criteria: z.array(z.string().min(1)).min(1),
  state: z
    .object({
      botToken: z.string().min(1).optional(),
      bot: z
        .object({
          id: z.string().min(1),
          username: z.string().min(1),
          globalName: z.string().nullable().optional(),
        })
        .optional(),
      application: z
        .object({ id: z.string().min(1), name: z.string().min(1) })
        .optional(),
      guildId: z.string().min(1).optional(),
      channels: z
        .array(
          z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              type: z.number().int(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .default({}),
  events: z.array(
    z.object({
      delayMs: z.number().int().nonnegative().default(0),
      envelope: z.object({
        kind: z.enum(['message', 'interaction']),
        payload: z.record(z.string(), z.unknown()),
        eventId: z.string().optional(),
      }),
    }),
  ),
  settleMs: z.number().int().positive().default(20_000),
  timeoutMs: z.number().int().positive().default(180_000),
});

const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    events: {
      type: 'string',
      default: 'http://localhost:13101/api/internal/discord/events',
    },
    port: { type: 'string', default: '3014' },
    target: { type: 'string', default: 'roomote@local-dev' },
    episode: { type: 'string', default: '1' },
    out: { type: 'string', default: '/tmp/discord-eval-bundles' },
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
// event-id dedup: every "$M<n>" becomes a unique snowflake-like id string —
// the same token maps to the same value within a run.
const runBase = Math.floor(Date.now() / 10) % 100_000_000;
const tokens = new Map<string, string>();
let tokenSeq = 0;
function tokenValue(token: string): string {
  let v = tokens.get(token);
  if (v === undefined) {
    v = `9${String(runBase).padStart(9, '0')}${String(++tokenSeq).padStart(4, '0')}`;
    tokens.set(token, v);
  }
  return v;
}
function substitute(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$M\d+/g, (m) => tokenValue(m));
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v)]),
    );
  }
  return value;
}

const appEnv = (
  process.env.R_APP_ENV ||
  process.env.APP_ENV ||
  process.env.NODE_ENV
)?.trim();
const gatewaySecret =
  process.env.R_DISCORD_GATEWAY_SECRET?.trim() ||
  (appEnv === 'development' ? process.env.ENCRYPTION_KEY?.trim() : undefined) ||
  '';

const server = new MockDiscordServer({
  ...(scenario.state.botToken ? { botToken: scenario.state.botToken } : {}),
  ...(scenario.state.bot ? { bot: scenario.state.bot } : {}),
  ...(scenario.state.application
    ? { application: scenario.state.application }
    : {}),
  ...(scenario.state.guildId ? { guildId: scenario.state.guildId } : {}),
  roomoteTarget: {
    eventsUrl: values.events!,
    gatewaySecret,
  },
});

for (const channel of scenario.state.channels ?? []) {
  server.addChannel(channel);
}

const { baseUrl, close } = await server.listen(
  Number.parseInt(values.port!, 10),
);
console.log(`mock discord listening at ${baseUrl} -> ${values.events}`);

if (
  process.env.DISCORD_API_BASE_URL &&
  process.env.DISCORD_API_BASE_URL.replace(/\/+$/, '') !== baseUrl
) {
  console.warn(
    `WARNING: DISCORD_API_BASE_URL=${process.env.DISCORD_API_BASE_URL} does not match ${baseUrl}; ` +
      `the API server may post replies somewhere else.`,
  );
}

const startedAt = Date.now();
const dispatched: { at: string; envelope: unknown; result: unknown }[] = [];

function flattenMessages() {
  return Object.entries(server.state.messages).flatMap(
    ([channelId, messages]) =>
      messages.map((message) => ({ channelId, ...message })),
  );
}

try {
  for (const { delayMs, envelope } of scenario.events) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const resolved = substitute(envelope) as {
      kind: 'message' | 'interaction';
      payload: Record<string, unknown>;
      eventId?: string;
    };
    const result = await server.dispatch(resolved);
    dispatched.push({
      at: new Date().toISOString(),
      envelope: resolved,
      result,
    });
    console.log(`dispatched ${resolved.kind} -> HTTP ${result.status}`);
  }

  // Settle: wait until the message log has been stable for settleMs (with
  // at least one bot message), or give up at timeoutMs and judge as-is.
  let lastCount = -1;
  let stableSince = Date.now();
  let timedOut = false;
  for (;;) {
    const messages = flattenMessages();
    if (messages.length !== lastCount) {
      lastCount = messages.length;
      stableSince = Date.now();
    }
    const hasBotMessage = messages.some((m) => m.author.bot);
    if (hasBotMessage && Date.now() - stableSince >= scenario.settleMs) break;
    if (Date.now() - startedAt >= scenario.timeoutMs) {
      timedOut = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const duration = Date.now() - startedAt;
  const messages = flattenMessages();
  const bundle = {
    name: scenario.name,
    target: values.target,
    episode,
    criteria: scenario.criteria,
    artifacts: {
      discord_transcript: JSON.stringify(messages, null, 2),
      channels: JSON.stringify(server.state.channels, null, 2),
      reactions: JSON.stringify(server.state.reactions, null, 2),
      dispatched_events: JSON.stringify(dispatched, null, 2),
      timing: [
        `run started ${new Date(startedAt).toISOString()}`,
        `settled after ${Math.round(duration / 1000)}s${timedOut ? ' (TIMEOUT reached before quiescence)' : ''}`,
        `bot: ${server.bot.username} (id ${server.bot.id})`,
      ].join('\n'),
    },
    duration,
  };

  await mkdir(values.out!, { recursive: true });
  const outFile = join(values.out!, `${scenario.name}-ep${episode}.json`);
  await writeFile(outFile, JSON.stringify(bundle, null, 2));
  const botCount = messages.filter((m) => m.author.bot).length;
  console.log(
    `captured ${messages.length} messages (${botCount} from bot)${timedOut ? ' [timeout]' : ''}`,
  );
  console.log(`bundle written to ${outFile}`);
} finally {
  await close();
}
