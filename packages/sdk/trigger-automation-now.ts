/**
 * Local repro trigger: runs a background automation exactly like the web
 * "Run now" button (manualTrigger: true). Untracked; delete after the repro.
 *
 * Usage:
 *   pnpm exec dotenvx run -f ../../.env.local -- pnpm exec tsx trigger-automation-now.ts <automationKey>
 */
import { runAutomationNow } from './src/server/automations';

const key = process.argv[2];

if (!key) {
  console.error('Usage: tsx trigger-automation-now.ts <automationKey>');
  process.exit(1);
}

runAutomationNow(key as never)
  .then((result) => {
    console.log('run-now result:', JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
