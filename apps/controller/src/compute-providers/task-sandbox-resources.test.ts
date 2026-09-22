import { describe, expect, it, vi } from 'vitest';

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock('@roomote/db/server', () => ({
  db: { query: { tasks: { findFirst } } },
  eq: vi.fn(),
  tasks: { id: 'id' },
}));

import { taskNeedsNestedDocker } from './task-sandbox-resources';

describe('taskNeedsNestedDocker', () => {
  it('provisions Fast-launched repository-free environment setup for Docker', async () => {
    await expect(
      taskNeedsNestedDocker(
        {
          payload: { repo: '__no_repositories__', preparesEnvironment: true },
        } as never,
        undefined,
      ),
    ).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
