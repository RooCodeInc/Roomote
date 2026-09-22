import { describe, expect, it } from 'vitest';

import { resolveGoverningIntegrationToolPolicies } from '../integration-tool-approvals';

const policy = (
  integrationId: string,
  toolName: string,
  mode: 'allow' | 'always_allow' | 'ask' | 'reject',
) => ({ integrationId, toolName, mode });

const modes = (policies: ReturnType<typeof policy>[]): Record<string, string> =>
  Object.fromEntries(policies.map((entry) => [entry.toolName, entry.mode]));

describe('resolveGoverningIntegrationToolPolicies', () => {
  it('lets a personal policy tighten but never loosen the deployment one', () => {
    const governing = resolveGoverningIntegrationToolPolicies({
      deploymentPolicies: [
        policy('linear', 'save_issue', 'ask'),
        policy('linear', 'delete_issue', 'reject'),
        policy('linear', 'list_issues', 'ask'),
      ],
      userPolicies: [
        policy('linear', 'save_issue', 'reject'),
        policy('linear', 'delete_issue', 'ask'),
        policy('linear', 'list_issues', 'allow'),
        policy('linear', 'get_issue', 'ask'),
      ],
      scopeOf: () => undefined,
    });
    expect(modes(governing)).toEqual({
      save_issue: 'reject',
      delete_issue: 'reject',
      list_issues: 'ask',
      get_issue: 'ask',
    });
  });

  it('keeps a stored Always allow unless the other layer is stricter', () => {
    const governing = resolveGoverningIntegrationToolPolicies({
      deploymentPolicies: [
        policy('linear', 'get_issue', 'always_allow'),
        policy('linear', 'save_issue', 'always_allow'),
      ],
      userPolicies: [
        policy('linear', 'save_issue', 'ask'),
        policy('linear', 'list_issues', 'always_allow'),
      ],
      scopeOf: () => undefined,
    });
    expect(modes(governing)).toEqual({
      get_issue: 'always_allow',
      save_issue: 'ask',
      list_issues: 'always_allow',
    });
  });

  it('governs a custom server by its own layer only, since names can coincide', () => {
    const resolve = (scope?: 'deployment' | 'personal') =>
      Object.keys(
        modes(
          resolveGoverningIntegrationToolPolicies({
            deploymentPolicies: [policy('tools', 'shared_only', 'reject')],
            userPolicies: [policy('tools', 'personal_only', 'reject')],
            scopeOf: () => scope,
          }),
        ),
      ).sort();

    expect(resolve('deployment')).toEqual(['shared_only']);
    expect(resolve('personal')).toEqual(['personal_only']);
    expect(resolve()).toEqual(['personal_only', 'shared_only']);
  });

  it('never lets distinct integration and tool pairs share one entry', () => {
    const governing = resolveGoverningIntegrationToolPolicies({
      deploymentPolicies: [policy('a', 'bc', 'ask')],
      userPolicies: [policy('ab', 'c', 'reject')],
      scopeOf: () => undefined,
    });
    expect(governing).toHaveLength(2);
  });
});
