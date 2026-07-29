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

test('GHCR release workflow announces only newly created releases in Discord', () => {
  const workflow = YAML.parse(
    readFileSync(join(repoRoot, '.github/workflows/publish-ghcr.yml'), 'utf8'),
  );

  const steps = workflow.jobs['create-github-release'].steps;
  const publishRelease = steps.find((step) => step.id === 'publish_release');
  const announceRelease = steps.find(
    (step) => step.name === 'Announce GitHub Release in Discord',
  );

  assert.match(publishRelease.run, /created=true/);
  assert.match(publishRelease.run, /created=false/);
  assert.equal(
    announceRelease.if,
    "${{ steps.publish_release.outputs.created == 'true' }}",
  );
  assert.equal(announceRelease['continue-on-error'], true);
  assert.equal(
    announceRelease.env.DISCORD_MAIN_WEBHOOK_URL,
    '${{ secrets.DISCORD_MAIN_WEBHOOK_URL }}',
  );
  assert.match(announceRelease.run, /build-discord-release-payload\.mjs/);
  assert.match(announceRelease.run, /--retry-all-errors/);
});
