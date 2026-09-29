// Run with tsx so the existing Roomote inference adapter can load TypeScript.
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      rule: { type: 'string' },
      repeats: { type: 'string' },
      thresholds: { type: 'string' },
      'examples-dir': { type: 'string' },
      'judgement-source': { type: 'string' },
      output: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Run from the Roomote root with dotenvx and tsx. Options: --rule <id>, --repeats <n>, --thresholds <comma-separated numbers>, --examples-dir <dir>, --judgement-source <checkout>, --output <json-path>, --dry-run. See .judgement/README.md.',
    );
    return 0;
  }
  const root = resolve(values.cwd ?? '.');
  const require = createRequire(
    join(root, 'packages/cloud-agents/package.json'),
  );
  const modulePath = values['judgement-source']
    ? resolve(values['judgement-source'], 'src/index.js')
    : require.resolve('@roo-code/judgement');
  const judgement = await import(pathToFileURL(modulePath).href);
  if (typeof judgement.calibrate !== 'function') {
    throw new Error(
      'The installed Judgement version has no calibration API. Use --judgement-source /path/to/judgement with the calibration branch.',
    );
  }
  // Roomote still pins 0.1.5. Stage its policy in the new harness layout without
  // changing the real policy or index. Remove this bridge when upgrading the hook.
  const policyText = await readFile(join(root, 'JUDGE.json'), 'utf8');
  const policy = judgement.parsePolicy(policyText);
  const criteria = policy.criteria.filter(
    (rule) => !values.rule || rule.id === values.rule,
  );
  if (!criteria.length) throw new Error('Unknown rule ID.');
  if (values.thresholds?.split(',').some((value) => !value.trim())) {
    throw new Error('Thresholds must be comma-separated numbers.');
  }
  const thresholds = values.thresholds?.split(',').map(Number);
  const examplesDir = resolve(
    root,
    values['examples-dir'] ?? '.judgement/examples',
  );
  const fixtures = await Promise.all(
    criteria.map(async (rule) => {
      const path = join(examplesDir, `${rule.id}.json`);
      return { rule, path, text: await readFile(path, 'utf8') };
    }),
  );
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  const cwd = await mkdtemp(join(tmpdir(), 'roomote-calibration-'));
  const reports = [];
  try {
    await mkdir(join(cwd, '.judgement'));
    await writeFile(join(cwd, '.judgement/rules.json'), policyText);
    const adapter = values['dry-run']
      ? null
      : await import(
          pathToFileURL(
            join(root, 'packages/cloud-agents/src/server/judge-file.ts'),
          ).href
        );
    for (const [index, { rule, text }] of fixtures.entries()) {
      const path = join(cwd, '.judgement', `fixture-${index}.json`);
      await writeFile(path, text);
      const report = await judgement.calibrate({
        cwd,
        ruleId: rule.id,
        examplesPath: path,
        repeats: Number(values.repeats ?? 3),
        thresholds: thresholds ?? [rule.threshold],
        concurrency: 2,
        deadlineMs: 3000,
        dryRun: values['dry-run'],
        signal: controller.signal,
        evaluate: async (request, signal) => {
          signal.throwIfAborted();
          const answer = await adapter.evaluateRepositoryJudgement(request);
          if (!answer) throw new Error('Roomote evaluator unavailable');
          return answer;
        },
      });
      reports.push(report);
      console.log(judgement.formatCalibrationReport(report));
    }
    if (values.output) {
      const output = resolve(root, values.output);
      await mkdir(dirname(output), { recursive: true });
      const hash = (text) => createHash('sha256').update(text).digest('hex');
      await writeFile(
        output,
        JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            policySha256: hash(policyText),
            fixtures: Object.fromEntries(
              fixtures.map(({ rule, text }) => [rule.id, hash(text)]),
            ),
            reports,
          },
          null,
          2,
        ) + '\n',
      );
    }
    // This suite checks expected behavior, including complete passes for valid
    // changes. A threshold recommendation alone can still leave valid cases incomplete.
    return values['dry-run'] ||
      reports.every((report) =>
        report.results.every(
          (run) => !run.operationalFailure && run.status === run.expected,
        ),
      )
      ? 0
      : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    await rm(cwd, { recursive: true, force: true });
  }
}

// Inference settings open shared database pools. Exit after cleanup and reporting.
main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      error.name === 'AbortError'
        ? 'Calibration interrupted.'
        : 'Calibration failed. Check the rule, fixtures, Judgement source, and local inference setup.',
    );
    if (error.message?.startsWith('The installed Judgement version'))
      console.error(error.message);
    process.exit(error.name === 'AbortError' ? 130 : 2);
  });
