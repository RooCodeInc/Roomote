import { describe, expect, it } from 'vitest';

import { resolveStricterIntegrationToolPolicyMode } from '../integration-tool-approvals';

describe('resolveStricterIntegrationToolPolicyMode', () => {
  it('lets a personal policy tighten but never loosen the deployment one', () => {
    expect(resolveStricterIntegrationToolPolicyMode(undefined, 'ask')).toBe(
      'ask',
    );
    expect(resolveStricterIntegrationToolPolicyMode('ask', 'reject')).toBe(
      'reject',
    );
    expect(resolveStricterIntegrationToolPolicyMode('ask', 'allow')).toBe(
      'ask',
    );
    expect(resolveStricterIntegrationToolPolicyMode('reject', 'ask')).toBe(
      'reject',
    );
    expect(
      resolveStricterIntegrationToolPolicyMode(undefined, undefined),
    ).toBeUndefined();
  });
});
