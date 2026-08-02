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
    2,
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

test('GHCR workflow publishes explicitly requested pull request images safely', () => {
  const publishWorkflow = YAML.parse(
    readFileSync(
      join(repoRoot, '.github/workflows/publish-pr-images.yml'),
      'utf8',
    ),
  );
  const ciWorkflow = YAML.parse(
    readFileSync(join(repoRoot, '.github/workflows/CI.yml'), 'utf8'),
  );

  assert.deepEqual(publishWorkflow.on.issue_comment.types, ['created']);
  assert.match(publishWorkflow.jobs.prepare.if, /\/publish-images/);
  assert.match(publishWorkflow.jobs.prepare.if, /state == 'open'/);
  assert.match(publishWorkflow.jobs.prepare.if, /OWNER/);
  assert.match(publishWorkflow.jobs.prepare.if, /MEMBER/);
  assert.match(publishWorkflow.jobs.prepare.if, /COLLABORATOR/);
  assert.equal(publishWorkflow.jobs.build, undefined);

  for (const jobName of ['docker-build-app', 'docker-build-worker']) {
    const job = ciWorkflow.jobs[jobName];
    const buildImage = job.steps.find((step) =>
      step.name.startsWith('Build publishable '),
    );
    const uploadImage = job.steps.find((step) =>
      step.name.startsWith('Upload publishable '),
    );
    assert.match(buildImage.if, /pull_request/);
    assert.match(buildImage.if, /amd64/);
    assert.match(buildImage.with.outputs, /type=docker/);
    assert.equal(buildImage.with.push, undefined);
    assert.equal(uploadImage.with['retention-days'], 1);
  }

  const prepareScript = publishWorkflow.jobs.prepare.steps[0].run;
  assert.match(prepareScript, /actions\/workflows\/CI\.yml\/runs/);
  assert.match(prepareScript, /conclusion == "success"/);
  assert.match(prepareScript, /pr-image-app/);

  const publisher = publishWorkflow.jobs.publish;
  assert.equal(publisher.permissions.packages, 'write');
  assert.equal(
    publisher.steps.some(
      (step) =>
        step.uses?.startsWith('actions/checkout') ||
        step.uses?.startsWith('./'),
    ),
    false,
  );
  const publishScript = publisher.steps.find(
    (step) => step.name === 'Import and publish images',
  ).run;
  assert.match(publishScript, /docker load/);
  assert.match(publishScript, /current_sha/);
  assert.match(publishScript, /current_base_sha/);
  assert.match(publishScript, /roomote-app roomote-worker/);
  assert.match(publishScript, /BASE_VERSION/);
  assert.equal(
    publisher.outputs.mutable_updated,
    '${{ steps.images.outputs.mutable_updated }}',
  );

  const commentJob = publishWorkflow.jobs.comment;
  assert.deepEqual(commentJob.needs, ['prepare', 'publish']);
  assert.equal(commentJob.permissions['pull-requests'], 'write');
  assert.match(commentJob.steps[0].run, /roomote-app/);
  assert.match(commentJob.steps[0].run, /roomote-worker/);
  assert.match(commentJob.steps[0].run, /Movable references/);
  assert.match(commentJob.steps[0].run, /MUTABLE_UPDATED/);
});
