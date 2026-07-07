#!/usr/bin/env tsx
/**
 * Manually trigger background agent jobs.
 *
 * Usage (from repo root):
 *   pnpm exec dotenvx run -f .env.local -- pnpm --filter @roomote/bullmq exec tsx scripts/trigger-agents.ts [agent...]
 *
 * Examples:
 *   # Run all background agents
 *   pnpm exec dotenvx run -f .env.local -- pnpm --filter @roomote/bullmq exec tsx scripts/trigger-agents.ts
 *
 *   # Run only the conflict scanner
 *   pnpm exec dotenvx run -f .env.local -- pnpm --filter @roomote/bullmq exec tsx scripts/trigger-agents.ts conflict
 *
 *   # Run announcer + suggester
 *   pnpm exec dotenvx run -f .env.local -- pnpm --filter @roomote/bullmq exec tsx scripts/trigger-agents.ts announcer suggester
 *
 * Valid agent names: conflict, announcer, suggester, all (default)
 */

import { conflictScanJob } from '../src/scheduled-jobs/conflict-scan';
import { announcerJob } from '../src/scheduled-jobs/announcer';
import { suggesterJob } from '../src/scheduled-jobs/suggester';

const AGENTS = {
  conflict: { name: 'Conflict Scanner', fn: conflictScanJob },
  announcer: { name: 'Announcer', fn: announcerJob },
  suggester: { name: 'Suggested Tasks', fn: suggesterJob },
} as const;

type AgentKey = keyof typeof AGENTS;

async function main() {
  const args = process.argv.slice(2).map((a) => a.toLowerCase());

  const selected: AgentKey[] =
    args.length === 0 || args.includes('all')
      ? (Object.keys(AGENTS) as AgentKey[])
      : (args.filter((a) => a in AGENTS) as AgentKey[]);

  if (selected.length === 0) {
    console.error(
      `Unknown agent(s): ${args.join(', ')}. Valid names: ${Object.keys(AGENTS).join(', ')}, all`,
    );
    process.exit(1);
  }

  console.log(
    `Triggering ${selected.length} agent(s): ${selected.map((k) => AGENTS[k].name).join(', ')}\n`,
  );

  for (const key of selected) {
    const agent = AGENTS[key];
    const start = Date.now();
    console.log(`▶ Running ${agent.name}...`);

    try {
      await agent.fn();
      console.log(
        `✓ ${agent.name} completed in ${((Date.now() - start) / 1000).toFixed(1)}s\n`,
      );
    } catch (error) {
      console.error(
        `✗ ${agent.name} failed after ${((Date.now() - start) / 1000).toFixed(1)}s:`,
        error,
      );
    }
  }

  console.log('Done. Exiting…');
  process.exit(0);
}

main();
