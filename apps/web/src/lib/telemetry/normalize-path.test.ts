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

  it('redacts standalone artifact owner ids, including all-letter task ids', () => {
    expect(normalizePath('/artifacts/task/qwertyuiopasd')).toEqual({
      path: '/artifacts/task/[taskId]',
    });
    expect(
      normalizePath('/artifacts/session/6b9df5a1-9e0f-4a1d-8a86-4242deadbeef'),
    ).toEqual({ path: '/artifacts/session/[sessionId]' });
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

  it('retains only bounded setup-step signal from query strings', () => {
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

  it('drops extra setup query fields instead of forwarding credentials or identifying content', () => {
    expect(
      normalizePath(
        '/setup',
        '?step=email-account&token=synthetic-marker&email=fixture%40example.invalid&provider=custom',
      ),
    ).toEqual({
      path: '/setup',
      search: 'step=email-account',
    });
    expect(normalizePath('/setup', '?token=synthetic-marker')).toEqual({
      path: '/setup',
    });
  });

  it.each(['custom-user-value', 'synthetic-marker', '', 'WELCOME'])(
    'omits unrecognized step value %j',
    (step) => {
      expect(
        normalizePath('/setup', new URLSearchParams({ step }).toString()),
      ).toEqual({ path: '/setup' });
    },
  );

  it('canonicalizes encoded and duplicate step parameters without retaining the raw query', () => {
    expect(
      normalizePath(
        '/setup',
        '?%73tep=welcome&step=synthetic-marker&token=synthetic-marker',
      ),
    ).toEqual({ path: '/setup', search: 'step=welcome' });
    expect(
      normalizePath('/setup', '?step=synthetic-marker&step=welcome'),
    ).toEqual({ path: '/setup' });
  });

  it('does not allow setup-lookalike route queries', () => {
    expect(
      normalizePath('/setup-extra', 'step=invoke&token=synthetic-marker'),
    ).toEqual({ path: '/setup-extra' });
    expect(normalizePath('/setup/custom', 'step=invoke')).toEqual({
      path: '/setup/custom',
    });
  });
});
