import { describe, expect, it, vi } from 'vitest';

import { destroyDockerInstance } from './docker';

describe('destroyDockerInstance', () => {
  it('disconnects every remaining endpoint before removing the task network', async () => {
    const runDocker = vi.fn(async (args: string[]) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        throw Object.assign(new Error('missing'), {
          code: 1,
          stderr: 'Error: No such object: roomote-worker-42',
        });
      }
      if (args[0] === 'network' && args[1] === 'inspect') {
        return JSON.stringify([
          {
            Containers: {
              api123: { Name: 'roomote-api' },
              preview456: { Name: 'roomote-preview-proxy' },
            },
          },
        ]);
      }
      return '';
    });

    await destroyDockerInstance({ instanceId: 'roomote-worker-42' }, runDocker);

    expect(runDocker).toHaveBeenCalledWith(
      ['network', 'disconnect', '-f', 'roomote-task-42', 'api123'],
      { signal: undefined, allowFailure: true },
    );
    expect(runDocker).toHaveBeenCalledWith(
      ['network', 'disconnect', '-f', 'roomote-task-42', 'preview456'],
      { signal: undefined, allowFailure: true },
    );
    expect(runDocker).toHaveBeenCalledWith(
      ['network', 'rm', 'roomote-task-42'],
      { signal: undefined, allowFailure: true },
    );

    const calls = runDocker.mock.calls.map(([args]) => args);
    const disconnectIndex = calls.findIndex((args) => args[1] === 'disconnect');
    const removeIndex = calls.findIndex(
      (args) => args[0] === 'network' && args[1] === 'rm',
    );
    expect(removeIndex).toBeGreaterThan(disconnectIndex);
  });

  it('keeps repeated teardown idempotent when resources are already gone', async () => {
    const runDocker = vi.fn(async (args: string[]) => {
      if (args[0] === 'container')
        throw Object.assign(new Error('missing'), {
          code: 1,
          stderr: 'Error: No such object: roomote-worker-43',
        });
      return '';
    });

    await expect(
      destroyDockerInstance({ instanceId: 'roomote-worker-43' }, runDocker),
    ).resolves.toEqual({});

    expect(runDocker).toHaveBeenCalledWith(
      ['network', 'rm', 'roomote-task-43'],
      { signal: undefined, allowFailure: true },
    );
    expect(runDocker).toHaveBeenLastCalledWith(
      ['volume', 'rm', '-f', 'roomote-worker-43-workspace'],
      { signal: undefined, allowFailure: true },
    );
  });

  it.each(['daemon', 'present', 'empty response', 'aborted'])(
    'does not report removal or dismantle its boundary after %s',
    async (mode) => {
      const controller = new AbortController();
      const runDocker = vi.fn(async (args: string[]) => {
        if (args[0] !== 'container') return '';
        if (mode === 'daemon')
          throw Object.assign(new Error('daemon unavailable'), {
            code: 1,
            stderr: 'Cannot connect to the Docker daemon',
          });
        if (mode === 'aborted') {
          controller.abort(new Error('timeout'));
          throw Object.assign(new Error('missing'), {
            code: 1,
            stderr: 'Error: No such object: worker',
          });
        }
        return mode === 'present' ? '[{"State":{"Running":true}}]' : '';
      });
      await expect(
        destroyDockerInstance(
          { instanceId: 'roomote-worker-44', signal: controller.signal },
          runDocker,
        ),
      ).rejects.toThrow();
      expect(runDocker.mock.calls.some(([args]) => args[0] === 'network')).toBe(
        false,
      );
      expect(
        runDocker.mock.calls.some(([args]) =>
          args.includes('roomote-worker-44-egress-policy'),
        ),
      ).toBe(false);
    },
  );
});
