import { describe, expect, it } from 'vitest';

import { normalizePath } from './normalize-path';

describe('normalizePath', () => {
  it('maps known dynamic routes to route patterns', () => {
    expect(normalizePath('/task/0f346me79229f')).toEqual({
      path: '/task/[taskId]',
    });
    expect(
      normalizePath('/task/0f346me79229f/artifacts/plans/some-plan.md'),
    ).toEqual({ path: '/task/[taskId]/artifacts/[path]' });
    expect(normalizePath('/task/0f346me79229f/previews/3000/foo')).toEqual({
      path: '/task/[taskId]/previews/[segments]',
    });
    expect(
      normalizePath(
        '/settings/environments/6b9df5a1-9e0f-4a1d-8a86-annoyance/edit',
      ),
    ).toEqual({ path: '/settings/environments/[environmentId]/edit' });
    expect(
      normalizePath(
        '/settings/cloud-projects/projects/6b9df5a1-9e0f-4a1d-8a86-4242deadbeef/edit',
      ),
    ).toEqual({
      path: '/settings/cloud-projects/projects/[environmentId]/edit',
    });
    expect(normalizePath('/invite/abc123secret')).toEqual({
      path: '/invite/[token]',
    });
  });

  it('redacts the task id on every task sub-route, including all-letter ids', () => {
    // Task ids are base-36, so they can contain no digits at all; the
    // task subtree must never rely on digit-based redaction.
    expect(normalizePath('/task/qwertyuiopasd/logs')).toEqual({
      path: '/task/[taskId]/logs',
    });
    expect(normalizePath('/task/qwertyuiopasd')).toEqual({
      path: '/task/[taskId]',
    });
    expect(normalizePath('/task/0f346me79229f/diff')).toEqual({
      path: '/task/[taskId]/diff',
    });
    expect(normalizePath('/task/0f346me79229f/browser')).toEqual({
      path: '/task/[taskId]/browser',
    });
  });

  it('keeps static routes intact', () => {
    expect(normalizePath('/')).toEqual({ path: '/' });
    expect(normalizePath('/tasks')).toEqual({ path: '/tasks' });
    expect(normalizePath('/settings/experimental')).toEqual({
      path: '/settings/experimental',
    });
    expect(normalizePath('/settings/misc')).toEqual({
      path: '/settings/misc',
    });
  });

  it('redacts id-like segments on unknown routes', () => {
    expect(normalizePath('/unknown/0f346me79229f')).toEqual({
      path: '/unknown/[id]',
    });
    expect(
      normalizePath('/unknown/6b9df5a1-9e0f-4a1d-8a86-4242deadbeef'),
    ).toEqual({ path: '/unknown/[id]' });
    expect(normalizePath('/unknown/12345')).toEqual({
      path: '/unknown/[id]',
    });
    expect(normalizePath('/unknown/plain-words')).toEqual({
      path: '/unknown/plain-words',
    });
  });

  it('drops query strings except on allowlisted routes', () => {
    expect(normalizePath('/tasks', 'foo=bar')).toEqual({ path: '/tasks' });
    expect(normalizePath('/setup', 'step=invoke')).toEqual({
      path: '/setup',
      search: 'step=invoke',
    });
    expect(normalizePath('/setup', '?step=invoke')).toEqual({
      path: '/setup',
      search: 'step=invoke',
    });
  });
});
