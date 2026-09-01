import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('release preparation delegates duplicated broad checks to PR CI', () => {
  const ciWorkflow = YAML.parse(
    readFileSync(join(repoRoot, '.github/workflows/CI.yml'), 'utf8'),
  );
  const docsWorkflow = YAML.parse(
    readFileSync(join(repoRoot, '.github/workflows/docs.yml'), 'utf8'),
  );
  const skill = readFileSync(
    join(repoRoot, '.agents/skills/changeset-release-pr/SKILL.md'),
    'utf8',
  );

  assert.deepEqual(ciWorkflow.on.pull_request.branches, ['main', 'develop']);
  const ciCommands = Object.values(ciWorkflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((command) => typeof command === 'string');
  for (const command of [
    'pnpm lint',
    'pnpm knip',
    'pnpm check-types',
    'pnpm test:ci',
    'pnpm test:release-scripts',
  ]) {
    assert.ok(ciCommands.includes(command), `${command} must remain in PR CI`);
  }

  assert.deepEqual(docsWorkflow.on.pull_request.branches, ['main', 'develop']);
  assert.ok(
    docsWorkflow.on.pull_request.paths.includes('apps/docs/**'),
    'docs changes must trigger docs PR validation',
  );
  assert.ok(
    docsWorkflow.jobs.docs.steps.some(
      (step) => step.run === 'pnpm --filter @roomote/docs check',
    ),
    'docs PR validation must include validation and broken-link checks',
  );

  assert.equal(
    skill.match(/allow the ordinary push hook to run exactly once/g)?.length,
    2,
  );
  assert.equal(
    skill.match(
      /when `apps\/docs` changed, the \*\*Docs\*\*\s+workflow succeed/g,
    )?.length,
    2,
  );
  assert.match(
    skill,
    /Do not merge the release PR until the\n\*\*CI\*\* workflow/,
  );
  assert.match(
    skill,
    /Do not merge the production\nhotfix PR until the \*\*CI\*\* workflow/,
  );
  assert.doesNotMatch(skill, /pnpm test:release-scripts/);
  assert.doesNotMatch(skill, /pnpm exec oxfmt --check/);
  assert.doesNotMatch(skill, /node scripts\/pre-push-checks\.mjs/);

  // Release-specific transition guards remain local to the canonical procedure.
  assert.match(skill, /Start from the current `origin\/develop` tip/);
  assert.match(skill, /`HEAD` is exactly `origin\/main`/);
  assert.match(skill, /root version is exactly one patch above/);
  assert.match(skill, /git diff --exit-code origin\/develop -- \.changeset/);
  assert.match(skill, /Wait for \*\*Tag Product Release\*\* to succeed/);
  assert.match(skill, /Wait for the tag-triggered \*\*Publish GHCR Images\*\*/);
});

test('release workflow keeps promotion as the only automated PR gate', () => {
  const workflow = YAML.parse(
    readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8'),
  );

  assert.deepEqual(Object.keys(workflow.jobs), ['promote']);
  assert.equal(workflow.jobs.promote.needs, undefined);
  assert.equal(workflow.on.workflow_dispatch.inputs.version.required, true);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);

  const promoteScript = workflow.jobs.promote.steps.find(
    (step) => typeof step.run === 'string',
  )?.run;
  assert.match(promoteScript, /find-version-commit\.mjs/);
  assert.match(promoteScript, /gh pr create/);
  assert.match(promoteScript, /develop is currently version/);
  assert.match(promoteScript, /Cannot refresh missing release branch/);
  assert.match(promoteScript, /Tag \$tag already exists/);
  assert.match(promoteScript, /main already contains candidate/);
  assert.match(promoteScript, /has diverged from develop/);
  assert.match(promoteScript, /no open Promote PR targets main/);
  assert.match(promoteScript, /Cannot refresh .* with pending changesets/);
  assert.equal(
    promoteScript.match(
      /git fetch origin "refs\/heads\/main:refs\/remotes\/origin\/main"(?: --tags)? --quiet/g,
    )?.length,
    3,
  );
  assert.doesNotMatch(promoteScript, /git fetch origin main/);
  assert.match(
    promoteScript,
    /the candidate reached main while this refresh was running/,
  );
  assert.match(
    promoteScript,
    /the Promote PR closed while this refresh was running/,
  );
  assert.match(promoteScript, /release_sha="\$bump_sha"/);
  assert.match(
    promoteScript,
    /points to \$\{remote_release_sha\}, expected \$\{release_sha\}; refusing to write Promote PR metadata/,
  );
  assert.match(
    promoteScript,
    /moved to \$\{remote_release_sha\}, expected \$\{release_sha\}; refusing to update Promote PR metadata/,
  );
  assert.match(
    promoteScript,
    /remote_release_sha="\$\(git ls-remote --exit-code --heads origin "refs\/heads\/\$\{release_branch\}" \| cut -f1\)"/,
  );
  assert.match(promoteScript, /shipping_guard_sha="\$candidate_sha"/);
  assert.match(promoteScript, /shipping_guard_sha="\$release_sha"/);
  assert.match(
    promoteScript,
    /the candidate reached main while the branch was being prepared/,
  );
  assert.match(
    promoteScript,
    /the Promote PR closed while the branch was being updated/,
  );
  assert.ok(
    promoteScript.indexOf(
      'the candidate reached main while the branch was being prepared',
    ) <
      promoteScript.indexOf(
        'notes="$(node scripts/release/extract-changelog-section.mjs',
      ),
  );
  assert.match(
    promoteScript,
    /git push origin "\$\{release_sha\}:refs\/heads\/\$\{release_branch\}"/,
  );
  assert.doesNotMatch(promoteScript, /--force(?:-with-lease)?/);
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
