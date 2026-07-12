import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('release workflow keeps promotion as the only automated PR gate', () => {
  const workflow = YAML.parse(
    readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8'),
  );

  assert.deepEqual(Object.keys(workflow.jobs), ['promote']);
  assert.equal(workflow.jobs.promote.needs, undefined);

  const promoteScript = workflow.jobs.promote.steps.find(
    (step) => typeof step.run === 'string',
  )?.run;
  assert.match(promoteScript, /find-version-commit\.mjs/);
  assert.match(promoteScript, /gh pr create/);
});
