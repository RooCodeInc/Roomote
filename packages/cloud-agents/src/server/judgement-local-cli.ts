import { parseArgs } from 'node:util';
import { exitCode, formatReport } from '@roo-code/judgement';
import { checkLocalRepositoryJudgement } from './judgement-local';

async function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      staged: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      hook: { type: 'boolean' },
      advisory: { type: 'boolean' },
      base: { type: 'string' },
      head: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-cache': { type: 'boolean' },
      format: { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'pnpm judgement [--verbose] [--dry-run] [--format json] [--hook] [--base <commit> --head <commit>] [--timeout-ms <ms>] [--advisory]\nUses Roomote Settings > Models and server-side provider credentials. Cache is disabled because deployment inference settings can change.',
    );
    return 0;
  }
  if (
    (values.staged && values.base) ||
    (values.head && !values.base) ||
    (values.hook && values.base) ||
    (values.format && !['text', 'json'].includes(values.format))
  ) {
    console.error('Invalid arguments. Use pnpm judgement --help.');
    return 2;
  }
  const report = await checkLocalRepositoryJudgement({
    cwd: values.cwd,
    base: values.base,
    head: values.head,
    hook: values.hook,
    dryRun: values['dry-run'],
    deadlineMs:
      values['timeout-ms'] === undefined
        ? undefined
        : Number(values['timeout-ms']),
    onDiagnostic: values.verbose
      ? (message) => console.error(`judgement: ${message}`)
      : undefined,
  });
  console.log(
    values.format === 'json' ? JSON.stringify(report) : formatReport(report),
  );
  return values['dry-run'] && report.status !== 'invalid'
    ? 0
    : exitCode(report, values);
}

// The settings resolver opens shared database pools; this one-shot CLI must
// exit after reporting rather than waiting for the server pools to idle out.
void main()
  .then((code) => process.exit(code))
  .catch(() => {
    console.error(
      'judgement: failed to start. Check arguments, .env.local, and local Roomote configuration.',
    );
    process.exit(2);
  });
