import { describe, expect, it, vi } from 'vitest';

import {
  formatUserCallableSkillsPage,
  listUserCallableFastAgentSkills,
  parseSkillsCommandPage,
  UserCallableSkillCatalogCache,
} from '../fast-agent-skill-command';
import type { UserCallableSkillCatalog } from '../fast-agent-skill-command';
import type { FastAgentSkillListResult } from '../fast-agent-skill-store';

function catalog(name: string): {
  skills: FastAgentSkillListResult['skills'];
  warnings: string[];
} {
  return {
    skills: [
      {
        description: `${name} description`,
        id: `packaged:${name}`,
        invocation: name,
        name,
        source: 'packaged',
      },
    ],
    warnings: [],
  };
}

const pendingRemote = {
  marketplaceSourceCount: 1,
  repositoryEnvironmentCount: 1,
};

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

  it('returns a cold local snapshot without waiting and starts one refresh', async () => {
    const refresh = vi.fn(
      () => new Promise<UserCallableSkillCatalog>(() => {}),
    );
    const cache = new UserCallableSkillCatalogCache();

    const result = cache.get({
      key: 'actor:user-1:revision:one',
      local: catalog('local'),
      page: 1,
      pending: pendingRemote,
      refresh,
    });

    expect(result.catalog).toMatchObject({
      remoteDiscovery: { status: 'partial' },
      skills: [expect.objectContaining({ name: 'local' })],
    });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('pins pagination while a refreshed snapshot waits for page one', async () => {
    let resolveRefresh!: (value: UserCallableSkillCatalog) => void;
    const refresh = vi.fn(
      () =>
        new Promise<UserCallableSkillCatalog>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const cache = new UserCallableSkillCatalogCache();
    const input = {
      key: 'actor:user-1:revision:one',
      local: catalog('local'),
      pending: pendingRemote,
      refresh,
    };
    cache.get({ ...input, page: 1 });
    cache.get({ ...input, page: 2 });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh(catalog('remote'));
    await vi.waitFor(() =>
      expect(cache.get({ ...input, page: 2 }).catalog).toMatchObject({
        remoteDiscovery: { status: 'ready' },
        skills: [expect.objectContaining({ name: 'local' })],
      }),
    );
    const promoted = cache.get({ ...input, page: 1 }).catalog;
    expect(promoted).toMatchObject({
      skills: [expect.objectContaining({ name: 'remote' })],
    });
    expect(promoted.remoteDiscovery).toBeUndefined();
  });

  it('keeps complete local catalogs synchronous without a refresh', () => {
    const refresh = vi.fn();
    const result = new UserCallableSkillCatalogCache().get({
      key: 'actor:user-1:revision:local',
      local: catalog('local'),
      page: 1,
      pending: {
        marketplaceSourceCount: 0,
        repositoryEnvironmentCount: 0,
      },
      refresh,
    });

    expect(result.catalog.remoteDiscovery).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('retries failed background discovery after the retry window', async () => {
    let now = 1_000;
    const cache = new UserCallableSkillCatalogCache(100, () => now);
    const refresh = vi
      .fn<() => Promise<UserCallableSkillCatalog>>()
      .mockRejectedValueOnce(new Error('discovery failed'))
      .mockResolvedValueOnce(catalog('remote'));
    const input = {
      key: 'actor:user-1:revision:one',
      local: catalog('local'),
      page: 1,
      pending: pendingRemote,
      refresh,
    };

    cache.get(input);
    await vi.waitFor(() =>
      expect(cache.get(input).catalog.remoteDiscovery?.status).toBe('failed'),
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    now += 30_001;
    cache.get(input);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes a complete snapshot after remote freshness expires', async () => {
    let now = 1_000;
    const cache = new UserCallableSkillCatalogCache(100, () => now);
    const refresh = vi
      .fn<() => Promise<UserCallableSkillCatalog>>()
      .mockResolvedValueOnce(catalog('remote-one'))
      .mockResolvedValueOnce(catalog('remote-two'));
    const input = {
      key: 'actor:user-1:revision:one',
      local: catalog('local'),
      page: 1,
      pending: pendingRemote,
      refresh,
    };

    cache.get(input);
    await vi.waitFor(() =>
      expect(cache.get(input).catalog.skills[0]?.name).toBe('remote-one'),
    );
    now += 5 * 60_000 + 1;
    cache.get(input);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(cache.get(input).catalog.skills[0]?.name).toBe('remote-two'),
    );
  });

  it('isolates actors and environment scopes with bounded retention', async () => {
    const cache = new UserCallableSkillCatalogCache(2);
    const refresh = vi.fn(
      () => new Promise<UserCallableSkillCatalog>(() => {}),
    );
    const load = (key: string) =>
      cache.get({
        key,
        local: catalog(key),
        page: 1,
        pending: pendingRemote,
        refresh,
      });

    load('actor:user-1:revision:env-1');
    load('actor:user-1:revision:env-2');
    load('actor:user-2:revision:env-1');
    const reloaded = load('actor:user-1:revision:env-1');

    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(reloaded.status).toBe('miss');
  });

  it('formats partial and ready snapshots without claiming completeness', () => {
    expect(
      formatUserCallableSkillsPage({
        catalog: withRemoteDiscoveryForTest(catalog('local'), 'partial'),
        command: '/skills',
      }),
    ).toContain('1 so far');
    expect(
      formatUserCallableSkillsPage({
        catalog: withRemoteDiscoveryForTest(catalog('local'), 'ready'),
        command: '/skills',
      }),
    ).toContain('updated full list is ready');
  });
});

function withRemoteDiscoveryForTest(
  value: UserCallableSkillCatalog,
  status: 'partial' | 'ready',
): UserCallableSkillCatalog {
  return {
    ...value,
    remoteDiscovery: { ...pendingRemote, status },
  };
}
