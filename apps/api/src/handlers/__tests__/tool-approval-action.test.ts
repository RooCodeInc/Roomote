import {
  db,
  eq,
  getIntegrationToolApproval,
  insertIntegrationToolApproval,
  integrationToolApprovalRequests,
  sessionFactory,
  sessions,
  setDeploymentExperimentEnabled,
  userFactory,
} from '@roomote/db/server';
import { decideCommunicationToolApproval } from '../tool-approval-action.js';

describe('provider tool approval actions', () => {
  const sessionIds: string[] = [];
  beforeEach(async () => {
    await setDeploymentExperimentEnabled('integrationToolApprovals', true);
  });
  afterAll(async () => {
    await setDeploymentExperimentEnabled('integrationToolApprovals', false);
    await db.delete(integrationToolApprovalRequests);
    for (const id of sessionIds)
      await db.delete(sessions).where(eq(sessions.id, id));
  });

  it('accepts only a linked requester once, removes the web pending row, and preserves the exact-call claim', async () => {
    const owner = await userFactory.create({ role: 'member' });
    const stranger = await userFactory.create({ role: 'member' });
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    sessionIds.push(session.id);
    const approval = await insertIntegrationToolApproval(
      { sessionId: session.id, userId: owner.id },
      {
        integrationId: 'example',
        toolName: 'write',
        nativeRequestId: 'provider-action-1',
        argsFingerprint: 'fingerprint',
        argsSummary: { secret: 'redacted' },
      },
    );
    const choice = {
      approvalId: approval.approvalId,
      decision: 'approved' as const,
    };
    expect(await decideCommunicationToolApproval(null, choice)).toBe(false);
    expect(await decideCommunicationToolApproval(stranger.id, choice)).toBe(
      false,
    );
    expect(await decideCommunicationToolApproval(owner.id, choice)).toBe(true);
    expect(await decideCommunicationToolApproval(owner.id, choice)).toBe(false);
    const row = await getIntegrationToolApproval(approval.approvalId);
    expect(row?.status).toBe('approved');
    expect(row?.argsFingerprint).toBe('fingerprint');
  });

  it('rejects a provider callback when the experiment has been disabled', async () => {
    const owner = await userFactory.create({ role: 'member' });
    const session = await sessionFactory.create({
      ownerKind: 'user',
      ownerUserId: owner.id,
    });
    sessionIds.push(session.id);
    const approval = await insertIntegrationToolApproval(
      { sessionId: session.id, userId: owner.id },
      {
        integrationId: 'example',
        toolName: 'write',
        nativeRequestId: 'provider-action-2',
        argsFingerprint: 'fingerprint',
        argsSummary: {},
      },
    );
    await setDeploymentExperimentEnabled('integrationToolApprovals', false);
    expect(
      await decideCommunicationToolApproval(owner.id, {
        approvalId: approval.approvalId,
        decision: 'rejected',
      }),
    ).toBe(false);
  });
});
