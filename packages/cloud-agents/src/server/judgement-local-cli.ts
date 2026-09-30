import { parseArgs } from 'node:util';
import {
  exitCode,
  formatReport,
  testRules,
  calibrateRules,
  formatExampleSuite,
  exampleSuiteExitCode,
} from '@roo-code/judgement';
import {
  checkLocalRepositoryJudgement,
  evaluateLocalRepositoryJudgement,
} from './judgement-local';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      all: { type: 'boolean' },
      rule: { type: 'string' },
      examples: { type: 'string' },
      'examples-dir': { type: 'string' },
      repeats: { type: 'string' },
      thresholds: { type: 'string' },
      concurrency: { type: 'string' },
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
      'pnpm judgement [--verbose] [--dry-run] [--format json] [--hook] [--base <commit> --head <commit>] [--timeout-ms <ms>] [--advisory]\npnpm judgement test [--rule <id>] [--dry-run] [--format json]\npnpm judgement calibrate (--rule <id> | --all) [--thresholds 0.8,0.85,0.9] [--format json]\nUses Roomote Settings > Models and server-side provider credentials. Cache is disabled because deployment inference settings can change.',
    );
    return 0;
  }
  const command = positionals[0] ?? 'check';
  if (
    positionals.length > 1 ||
    !['check', 'test', 'calibrate'].includes(command)
  ) {
    throw new Error('Invalid command.');
  }
  if (command !== 'check') {
    if (
      values.staged ||
      values.base ||
      values.head ||
      values.hook ||
      values.advisory ||
      (values.all && values.rule) ||
      (values.examples && values['examples-dir']) ||
      (command === 'test' && values.thresholds !== undefined) ||
      (command === 'calibrate' && !values.rule && !values.all) ||
      values.thresholds?.split(',').some((value) => !value.trim()) ||
      (values.format && !['text', 'json'].includes(values.format))
    ) {
      throw new Error('Invalid example command arguments.');
    }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    try {
      const options = {
        cwd: values.cwd,
        ruleId: values.rule,
        examplesPath: values.examples,
        examplesDirectory: values['examples-dir'],
        repeats:
          values.repeats === undefined ? undefined : Number(values.repeats),
        concurrency:
          values.concurrency === undefined
            ? undefined
            : Number(values.concurrency),
        deadlineMs:
          values['timeout-ms'] === undefined
            ? undefined
            : Number(values['timeout-ms']),
        dryRun: values['dry-run'],
        signal: controller.signal,
        evaluate: evaluateLocalRepositoryJudgement,
        onDiagnostic: values.verbose
          ? (message: string) => console.error(`judgement: ${message}`)
          : undefined,
      };
      const report =
        command === 'test'
          ? await testRules(options)
          : await calibrateRules({
              ...options,
              thresholds: values.thresholds?.split(',').map(Number),
            });
      console.log(
        values.format === 'json'
          ? JSON.stringify(report)
          : formatExampleSuite(report),
      );
      return exampleSuiteExitCode(report);
    } finally {
      process.removeListener('SIGINT', interrupt);
    }
  }
  if (
    values.all ||
    values.rule ||
    values.examples ||
    values['examples-dir'] ||
    values.repeats ||
    values.thresholds ||
    values.concurrency
  ) {
    throw new Error('Example options require test or calibrate.');
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
  .catch((error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('judgement: interrupted.');
      process.exit(130);
    }
    console.error(
      'judgement: failed to start. Check arguments, .env.local, and local Roomote configuration.',
    );
    process.exit(2);
  });
