import { readFileSync } from 'node:fs';

const dockerfile = readFileSync(
  new URL('../../../.docker/app/Dockerfile', import.meta.url),
  'utf8',
);

describe('BullMQ image runtime dependencies', () => {
  it('installs and verifies zod in the BullMQ runtime tree', () => {
    const buildStage = dockerfile
      .split(/^FROM /mu)
      .find((stage) => stage.startsWith('base AS build-bullmq'));

    expect(buildStage).toContain(
      '"zod@$(cd /roomote/apps/bullmq && node -p "require(\'zod/package.json\').version")"',
    );
    expect(buildStage).toContain(
      'test "$(node -p "require(\'zod/package.json\').version")" =',
    );
  });

  it('verifies zod resolves from the final BullMQ image layout', () => {
    const runtimeStage = dockerfile
      .split(/^FROM /mu)
      .find((stage) =>
        stage.startsWith('runtime-inference-base AS runtime-app'),
      );

    expect(runtimeStage).toContain(
      'cd /roomote/apps/bullmq && node -e "require.resolve(\'zod/package.json\')"',
    );
  });
});
