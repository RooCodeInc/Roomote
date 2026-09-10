import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(process.cwd(), '../..');

describe('gbrain image configuration', () => {
  it('pins the latest validated upstream release without runtime patching', async () => {
    const dockerfile = await readFile(
      path.join(repositoryRoot, '.docker/gbrain/Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain(
      'ARG GBRAIN_REF=f49ca569232dbc0d8e0783d84606115e3bfe5ab1',
    );
    expect(dockerfile).not.toContain('.patch');
    expect(dockerfile).not.toContain('git apply');
  });

  it('uses supported native gateway and one-shot synthesis configuration', async () => {
    const entrypoint = await readFile(
      path.join(repositoryRoot, '.docker/gbrain/entrypoint.sh'),
      'utf8',
    );

    expect(entrypoint).toContain(
      'gbrain config set dream.synthesize.mode oneshot',
    );
    expect(entrypoint).toContain(
      'gbrain config set dream.synthesize.link_manifest true',
    );
    expect(entrypoint).toContain(
      'gbrain config set agent.use_gateway_loop true',
    );
    expect(entrypoint).toContain(
      'https://github.com/garrytan/gbrain/issues/4294',
    );
    // A supervisor beaten to the queue lock by a container still being
    // replaced retries instead of taking the server down (LOCK_HELD = 2).
    expect(entrypoint).toContain('SUPERVISOR_LOCK_HELD_EXIT=2');
    expect(entrypoint).toContain('run_job_worker &');
    expect(entrypoint).toContain(
      'retrying in ${SUPERVISOR_LOCK_RETRY_SECONDS}s',
    );
  });
});
