import {
  buildIntegrationToolApprovalCallback,
  integrationToolApprovalButtons,
  integrationToolApprovalMessage,
  parseIntegrationToolApprovalCallback,
} from '../integration-tool-approvals';

const id = '3f0c8f0e-1111-4222-8333-444455556666';

it.each(['approved', 'approved_for_session', 'rejected'] as const)(
  'round-trips the %s decision within Telegram callback limits',
  (decision) => {
    const value = buildIntegrationToolApprovalCallback(id, decision);
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(parseIntegrationToolApprovalCallback(value)).toEqual({
      approvalId: id,
      decision,
    });
    expect(integrationToolApprovalButtons(id)[0]).toHaveLength(3);
  },
);

it('rejects malformed callback data and displays only persisted redacted arguments', () => {
  expect(parseIntegrationToolApprovalCallback('ita:not-a-uuid:o')).toBeNull();
  const text = integrationToolApprovalMessage({
    approvalId: id,
    integrationId: 'mock',
    toolName: 'send',
    argsSummary: { token: '[REDACTED]' },
    status: 'pending',
    taskId: null,
    expiresAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
  expect(text).toContain('[REDACTED]');
  expect(text).toContain('mock / send');
});
