import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareExamples, question } from '@roo-code/judgement';

const cwd = fileURLToPath(new URL('../../..', import.meta.url));
const destination = new URL(
  '../src/server/judgement-presets.generated.json',
  import.meta.url,
);
const prepared = await prepareExamples({ cwd });
// Shared questions occur in every packet; store each variant once.
const questionSets = [];
const indexes = new Map();
const examples = prepared.examples.map((example) => ({
  ...example,
  packets: example.packets.map(({ state, stage, questions: baseline }) => {
    const questions = {
      standard: baseline,
      combined: { result: question(state, { combineAcceptedOutcomes: true }) },
    };
    const key = JSON.stringify(questions);
    if (!indexes.has(key)) {
      indexes.set(key, questionSets.length);
      questionSets.push(questions);
    }
    return { state, stage, questionSet: indexes.get(key) };
  }),
}));
const files = [
  '.judgement/rules.json',
  ...Object.keys(prepared.fixtureSha256).map(
    (id) => `.judgement/examples/${id}.json`,
  ),
  'packages/cloud-agents/scripts/prepare-judgement-presets.mjs',
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    files.map(async (path) => [
      path,
      createHash('sha256')
        .update(await readFile(join(cwd, path)))
        .digest('hex'),
    ]),
  ),
);
const library = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).dependencies['@roo-code/judgement'];
const content =
  JSON.stringify(
    { ...prepared, sourceHashes, library, examples, questionSets },
    null,
    2,
  ) + '\n';
if (process.argv.includes('--check')) {
  if (
    JSON.stringify(JSON.parse(await readFile(destination, 'utf8'))) !==
    JSON.stringify(JSON.parse(content))
  ) {
    throw new Error('Judgement presets are stale. Run pnpm judgement:presets.');
  }
} else {
  await writeFile(destination, content);
}
console.log(
  `${examples.length} Judgement examples ${process.argv.includes('--check') ? 'verified' : 'prepared'}; no inference calls.`,
);
