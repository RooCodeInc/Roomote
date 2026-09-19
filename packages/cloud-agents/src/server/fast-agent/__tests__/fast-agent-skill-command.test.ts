import { describe, expect, it, vi } from 'vitest';

import {
  formatUserCallableSkillsPage,
  listUserCallableFastAgentSkills,
  parseSkillsCommandPage,
  UserCallableSkillCatalogCache,
} from '../fast-agent-skill-command';
import type { FastAgentSkillListResult } from '../fast-agent-skill-store';

describe('Fast skill command', () => {
  it('merges scoped catalogs using canonical precedence', async () => {
    const catalog = await listUserCallableFastAgentSkills('user-1', {
      environmentIds: ['env-1'],
      log: vi.fn(),
      list: async (environmentId) => ({
        skills: environmentId
          ? [
              {
                id: 'repository:one',
                name: 'review',
                invocation: 'review',
                description: 'Repository review',
                source: 'repository',
              },
              {
                id: 'repository:deploy',
                name: 'deploy',
                invocation: 'deploy',
                description: 'Deploy this repository',
                source: 'repository',
              },
            ]
          : [
              {
                id: 'packaged:review',
                name: 'review',
                invocation: 'review',
                description: 'Packaged review',
                source: 'packaged',
              },
            ],
        warnings: environmentId ? ['repository warning'] : [],
      }),
    });

    expect(catalog.skills).toEqual([
      expect.objectContaining({ invocation: 'deploy', source: 'repository' }),
      expect.objectContaining({ invocation: 'review', source: 'packaged' }),
    ]);
    expect(catalog.warnings).toEqual(['repository warning']);
  });

  it('paginates without silently dropping remaining skills', () => {
    const text = formatUserCallableSkillsPage({
      catalog: {
        skills: Array.from({ length: 11 }, (_, index) => ({
          id: `packaged:skill-${index}`,
          name: `skill-${index}`,
          invocation: `skill-${index}`,
          description: 'A useful skill',
          source: 'packaged' as const,
        })),
        warnings: ['one source failed'],
      },
      page: 1,
      command: '/skills',
    });

    expect(text).toContain('page 1/2');
    expect(text).toContain('Next page: `/skills 2`.');
    expect(text).toContain('could not be fully inspected');
    expect(text).not.toContain('$skill-10` —');
  });

  it('keeps same-invocation scoped skills at the winning precedence', async () => {
    const catalog = await listUserCallableFastAgentSkills('user-1', {
      environmentIds: ['env-b', 'env-a'],
      log: vi.fn(),
      list: async (environmentId) => ({
        skills: environmentId
          ? [
              {
                id: `repository:${environmentId}`,
                name: 'deploy',
                invocation: 'deploy',
                description: `Deploy from ${environmentId}. `.repeat(12),
                repository: `example/${environmentId}`,
                source: 'repository',
              },
            ]
          : [],
        warnings: [],
      }),
    });

    expect(catalog.skills).toEqual([
      expect.objectContaining({
        id: 'repository:env-a',
        invocation: 'deploy',
      }),
      expect.objectContaining({
        id: 'repository:env-b',
        invocation: 'deploy',
      }),
    ]);
    const formatted = formatUserCallableSkillsPage({
      catalog,
      command: '/skills',
    });
    expect(formatted).toContain('… (example/env-a)');
    expect(formatted).toContain('… (example/env-b)');
  });

  it('recognizes bounded skills command syntax', () => {
    expect(parseSkillsCommandPage('/skills')).toBe(1);
    expect(parseSkillsCommandPage('skills 3')).toBe(3);
    expect(parseSkillsCommandPage('/skills all')).toBeNull();
    expect(parseSkillsCommandPage('show skills')).toBeNull();
  });

  it('reuses a catalog across pagination and joins in-flight discovery', async () => {
    let resolveList!: (result: FastAgentSkillListResult) => void;
    const pending = new Promise<FastAgentSkillListResult>((resolve) => {
      resolveList = resolve;
    });
    const list = vi.fn(() => pending);
    const cache = new UserCallableSkillCatalogCache();
    const dependencies = {
      cache,
      environmentIds: [],
      list,
      log: vi.fn(),
    };

    const first = listUserCallableFastAgentSkills('user-1', dependencies);
    const second = listUserCallableFastAgentSkills('user-1', dependencies);
    resolveList({ skills: [], warnings: [] });
    await Promise.all([first, second]);
    await listUserCallableFastAgentSkills('user-1', dependencies);

    expect(list).toHaveBeenCalledTimes(1);
    expect(dependencies.log).toHaveBeenCalledWith(
      expect.stringContaining('cache_status=joined'),
    );
    expect(dependencies.log).toHaveBeenCalledWith(
      expect.stringContaining('cache_status=hit'),
    );
  });

  it('expires cached catalogs', async () => {
    let now = 1_000;
    const cache = new UserCallableSkillCatalogCache(100, 100, () => now);
    const list = vi.fn(async () => ({ skills: [], warnings: [] }));
    const dependencies = {
      cache,
      environmentIds: [],
      list,
      log: vi.fn(),
    };

    await listUserCallableFastAgentSkills('user-1', dependencies);
    await listUserCallableFastAgentSkills('user-1', dependencies);
    now += 101;
    await listUserCallableFastAgentSkills('user-1', dependencies);

    expect(list).toHaveBeenCalledTimes(2);
  });

  it('isolates actors and environment scopes with bounded retention', async () => {
    const cache = new UserCallableSkillCatalogCache(1_000, 2);
    const list = vi.fn(async () => ({ skills: [], warnings: [] }));
    const load = (userId: string, environmentIds: string[]) =>
      listUserCallableFastAgentSkills(userId, {
        cache,
        environmentIds,
        list,
        log: vi.fn(),
      });

    await load('user-1', ['env-1']);
    await load('user-1', ['env-2']);
    await load('user-2', ['env-1']);
    await load('user-1', ['env-1']);

    expect(list).toHaveBeenCalledTimes(8);
  });

  it('does not cache failed catalog discovery', async () => {
    const cache = new UserCallableSkillCatalogCache();
    const list = vi
      .fn<() => Promise<FastAgentSkillListResult>>()
      .mockRejectedValueOnce(new Error('discovery failed'))
      .mockResolvedValueOnce({ skills: [], warnings: [] });
    const dependencies = {
      cache,
      environmentIds: [],
      list,
      log: vi.fn(),
    };

    await expect(
      listUserCallableFastAgentSkills('user-1', dependencies),
    ).rejects.toThrow('discovery failed');
    await expect(
      listUserCallableFastAgentSkills('user-1', dependencies),
    ).resolves.toEqual({ skills: [], warnings: [] });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
