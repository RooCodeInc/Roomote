import {
  db,
  eq,
  integrationToolApprovalRequests,
  sessionFactory,
  sessions,
  userFactory,
} from '../../server';
import {
  cancelOpenIntegrationToolApprovals,
  decideIntegrationToolApproval,
  expireIntegrationToolApproval,
  fingerprintIntegrationToolCall,
  getIntegrationToolApproval,
  insertIntegrationToolApproval,
  IntegrationToolApprovalUnavailableError,
  listIntegrationToolPolicies,
  listPendingIntegrationToolApprovals,
  markIntegrationToolApprovalConsumed,
  redactIntegrationToolArgs,
  upsertIntegrationToolPolicy,
} from '../integration-tool-approvals';

const userIds: string[] = [];
const sessionIds: string[] = [];

async function user() {
  const created = await userFactory.create({ role: 'member' });
  userIds.push(created.id);
  return created.id;
}

async function ownedSession(ownerUserId: string) {
  const created = await sessionFactory.create({
    ownerKind: 'user',
    ownerUserId,
  });
  sessionIds.push(created.id);
  return created.id;
}

let nativeRequestCounter = 0;
function nextNativeRequestId() {
  nativeRequestCounter += 1;
  return `native-request-${nativeRequestCounter}`;
}

const call = {
  integrationId: 'mockslack',
  toolName: 'post_to_channel',
  args: { channel: 'C123', text: 'hello' },
};

function fingerprint(args: unknown = call.args) {
  return fingerprintIntegrationToolCall({ ...call, args });
}

async function insertPending(
  context: { sessionId: string; userId: string },
  args: unknown = call.args,
) {
  return insertIntegrationToolApproval(context, {
    integrationId: call.integrationId,
    toolName: call.toolName,
    nativeRequestId: nextNativeRequestId(),
    argsFingerprint: fingerprint(args),
    argsSummary: args,
  });
}

afterAll(async () => {
  await db.delete(integrationToolApprovalRequests);
  for (const sessionId of sessionIds) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
});

describe('fingerprintIntegrationToolCall', () => {
  it('is stable across argument key order and changes with the arguments', () => {
    const first = fingerprintIntegrationToolCall({
      ...call,
      args: { text: 'hello', channel: 'C123' },
    });
    expect(first).toBe(fingerprint());
    expect(fingerprint({ channel: 'C123', text: 'changed' })).not.toBe(first);
  });
});

describe('redactIntegrationToolArgs', () => {
  it('redacts secret-looking keys and truncates oversized strings', () => {
    const redacted = redactIntegrationToolArgs({
      text: 'hello',
      apiKey: 'sk-live-value',
      nested: { authorization: 'Bearer x', note: 'ok' },
      long: 'x'.repeat(500),
    }) as Record<string, unknown>;
    expect(redacted.text).toBe('hello');
    expect(redacted.apiKey).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).authorization).toBe(
      '[redacted]',
    );
    expect((redacted.nested as Record<string, unknown>).note).toBe('ok');
    expect(String(redacted.long)).toContain('[truncated]');
    expect(String(redacted.long).length).toBeLessThan(230);
  });
});

describe('integration tool policies', () => {
  it('stores non-default modes, updates them, and deletes on reset to allow', async () => {
    const admin = await user();
    await upsertIntegrationToolPolicy({
      integrationId: 'mockslack',
      toolName: 'post_to_channel',
      mode: 'ask',
      updatedByUserId: admin,
    });
    await upsertIntegrationToolPolicy({
      integrationId: 'mockslack',
      toolName: 'delete_channel',
      mode: 'reject',
      updatedByUserId: admin,
    });
    let policies = await listIntegrationToolPolicies();
    expect(
      policies.map(
        (policy) => `${policy.integrationId}:${policy.toolName}:${policy.mode}`,
      ),
    ).toEqual([
      'mockslack:delete_channel:reject',
      'mockslack:post_to_channel:ask',
    ]);
    await upsertIntegrationToolPolicy({
      integrationId: 'mockslack',
      toolName: 'post_to_channel',
      mode: 'reject',
      updatedByUserId: admin,
    });
    policies = await listIntegrationToolPolicies();
    expect(
      policies.find((policy) => policy.toolName === 'post_to_channel')?.mode,
    ).toBe('reject');
    // Resetting to the default removes the row instead of storing `allow`.
    await upsertIntegrationToolPolicy({
      integrationId: 'mockslack',
      toolName: 'post_to_channel',
      mode: 'allow',
      updatedByUserId: admin,
    });
    policies = await listIntegrationToolPolicies();
    expect(policies.map((policy) => policy.toolName)).toEqual([
      'delete_channel',
    ]);
    await upsertIntegrationToolPolicy({
      integrationId: 'mockslack',
      toolName: 'delete_channel',
      mode: 'allow',
      updatedByUserId: admin,
    });
  });

  it('stores the auto instruction and clears it for non-auto modes', async () => {
    const admin = await user();
    await upsertIntegrationToolPolicy({
      integrationId: 'mockslack',
      toolName: 'read_channel',
      mode: 'auto',
      instruction: 'Only read-only lookups',
      updatedByUserId: admin,
    });
    let policies = await listIntegrationToolPolicies();
    expect(policies.find((p) => p.toolName === 'read_channel')).toMatchObject({
      mode: 'auto',
      instruction: 'Only read-only lookups',
    });
    // Switching away from auto drops the instruction with the mode.
    await upsertIntegrationToolPolicy({
      integrationId: 'mockslack',
      toolName: 'read_channel',
      mode: 'ask',
      updatedByUserId: admin,
    });
    policies = await listIntegrationToolPolicies();
    expect(policies.find((p) => p.toolName === 'read_channel')).toMatchObject({
      mode: 'ask',
    });
    expect(
      policies.find((p) => p.toolName === 'read_channel')?.instruction,
    ).toBeUndefined();
    await upsertIntegrationToolPolicy({
      integrationId: 'mockslack',
      toolName: 'read_channel',
      mode: 'allow',
      updatedByUserId: admin,
    });
  });
});

describe('insertIntegrationToolApproval', () => {
  it('creates a pending approval bound to the session owner', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    expect(approval.status).toBe('pending');
    expect(approval.integrationId).toBe(call.integrationId);
    expect(Date.parse(approval.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('reuses the open row for the same native request instead of stacking', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const context = { sessionId, userId };
    const nativeRequestId = nextNativeRequestId();
    const insert = () =>
      insertIntegrationToolApproval(context, {
        integrationId: call.integrationId,
        toolName: call.toolName,
        nativeRequestId,
        argsFingerprint: fingerprint(),
        argsSummary: call.args,
      });
    const first = await insert();
    const second = await insert();
    expect(second.approvalId).toBe(first.approvalId);
    // Concurrent duplicate events for the same native request also collapse.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => insert()),
    );
    expect(new Set(results.map((result) => result.approvalId)).size).toBe(1);
    expect((await listPendingIntegrationToolApprovals(context)).length).toBe(1);
  });

  it('treats a new native request as a separate decision even with identical arguments', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const first = await insertPending({ sessionId, userId });
    const second = await insertPending({ sessionId, userId });
    expect(second.approvalId).not.toBe(first.approvalId);
  });

  it('rejects insertions for a session the user does not own', async () => {
    const ownerId = await user();
    const otherId = await user();
    const sessionId = await ownedSession(ownerId);
    await expect(insertPending({ sessionId, userId: otherId })).rejects.toThrow(
      IntegrationToolApprovalUnavailableError,
    );
  });
});

describe('insertIntegrationToolApproval shadow evaluation', () => {
  it('records the advisory evaluation bound to the request fingerprint, alongside the still-pending human decision', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const argsFingerprint = fingerprint();
    const approval = await insertIntegrationToolApproval(
      { sessionId, userId },
      {
        integrationId: call.integrationId,
        toolName: call.toolName,
        nativeRequestId: nextNativeRequestId(),
        argsFingerprint,
        argsSummary: call.args,
        shadowEvaluation: {
          recommendation: 'would_approve',
          reason: 'The judgment model would have approved this call.',
          confidence: 0.9,
          provider: 'typesafe',
          model: 'jev-latest',
          instruction: 'Only actions clearly requested by the user',
          argsFingerprint,
          evaluatedAt: new Date().toISOString(),
        },
      },
    );
    // The evaluation never authorizes: the row is still a pending human ask.
    expect(approval.status).toBe('pending');
    expect(approval.shadowEvaluation).toMatchObject({
      recommendation: 'would_approve',
      confidence: 0.9,
      model: 'jev-latest',
      argsFingerprint,
    });
    const row = await getIntegrationToolApproval(approval.approvalId);
    expect(row?.shadowEvaluation?.recommendation).toBe('would_approve');
  });

  it('correlates the recorded recommendation with the eventual human decision on the same row', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertIntegrationToolApproval(
      { sessionId, userId },
      {
        integrationId: call.integrationId,
        toolName: call.toolName,
        nativeRequestId: nextNativeRequestId(),
        argsFingerprint: fingerprint(),
        argsSummary: call.args,
        shadowEvaluation: {
          recommendation: 'would_ask',
          reason: 'The judgment model would still have asked a human.',
          instruction: 'x',
          argsFingerprint: fingerprint(),
          evaluatedAt: new Date().toISOString(),
        },
      },
    );
    const decided = await decideIntegrationToolApproval(
      { sessionId, userId },
      { approvalId: approval.approvalId, decision: 'approved' },
    );
    expect(decided.status).toBe('approved');
    expect(decided.shadowEvaluation?.recommendation).toBe('would_ask');
  });
});

describe('decideIntegrationToolApproval', () => {
  it('lets the requester approve exactly once', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    const decided = await decideIntegrationToolApproval(
      { sessionId, userId },
      { approvalId: approval.approvalId, decision: 'approved' },
    );
    expect(decided.status).toBe('approved');
    await expect(
      decideIntegrationToolApproval(
        { sessionId, userId },
        { approvalId: approval.approvalId, decision: 'rejected' },
      ),
    ).rejects.toThrow(IntegrationToolApprovalUnavailableError);
  });

  it('fails closed for a wrong approver and leaves the ask answerable', async () => {
    const userId = await user();
    const otherId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await expect(
      decideIntegrationToolApproval(
        { sessionId, userId: otherId },
        { approvalId: approval.approvalId, decision: 'approved' },
      ),
    ).rejects.toThrow(IntegrationToolApprovalUnavailableError);
    const decided = await decideIntegrationToolApproval(
      { sessionId, userId },
      { approvalId: approval.approvalId, decision: 'rejected' },
    );
    expect(decided.status).toBe('rejected');
  });

  it('fails closed once the approval has expired', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await db
      .update(integrationToolApprovalRequests)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(integrationToolApprovalRequests.id, approval.approvalId));
    await expect(
      decideIntegrationToolApproval(
        { sessionId, userId },
        { approvalId: approval.approvalId, decision: 'approved' },
      ),
    ).rejects.toThrow(IntegrationToolApprovalUnavailableError);
  });
});

describe('markIntegrationToolApprovalConsumed', () => {
  it('consumes an approved row exactly once and never a pending or rejected one', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await expect(
      markIntegrationToolApprovalConsumed({
        approvalId: approval.approvalId,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);
    await decideIntegrationToolApproval(
      { sessionId, userId },
      { approvalId: approval.approvalId, decision: 'approved' },
    );
    await expect(
      markIntegrationToolApprovalConsumed({
        approvalId: approval.approvalId,
        requesterUserId: userId,
      }),
    ).resolves.toBe(true);
    await expect(
      markIntegrationToolApprovalConsumed({
        approvalId: approval.approvalId,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);
    expect(
      (await getIntegrationToolApproval(approval.approvalId))?.status,
    ).toBe('consumed');
  });
});

describe('expireIntegrationToolApproval', () => {
  it('fails an unanswered approval closed and hides it from pending lists', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await expireIntegrationToolApproval(approval.approvalId);
    expect(
      (await getIntegrationToolApproval(approval.approvalId))?.status,
    ).toBe('expired');
    expect(
      await listPendingIntegrationToolApprovals({ sessionId, userId }),
    ).toHaveLength(0);
  });
});

describe('cancelOpenIntegrationToolApprovals', () => {
  it('cancels pending and approved-unclaimed rows with a reason and never resurrects them', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const pending = await insertPending({ sessionId, userId });
    const approved = await insertPending({ sessionId, userId });
    await decideIntegrationToolApproval(
      { sessionId, userId },
      { approvalId: approved.approvalId, decision: 'approved' },
    );
    const cancelled = await cancelOpenIntegrationToolApprovals(
      'experiment_disabled',
    );
    expect(cancelled).toBeGreaterThanOrEqual(2);
    for (const id of [pending.approvalId, approved.approvalId]) {
      const row = await getIntegrationToolApproval(id);
      expect(row?.status).toBe('cancelled');
      expect(row?.cancelReason).toBe('experiment_disabled');
    }
    // Approved-but-unclaimed can no longer be relayed for execution.
    await expect(
      markIntegrationToolApprovalConsumed({
        approvalId: approved.approvalId,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);
    // Cancelled rows stay terminal: decisions land on nothing.
    await expect(
      decideIntegrationToolApproval(
        { sessionId, userId },
        { approvalId: pending.approvalId, decision: 'approved' },
      ),
    ).rejects.toThrow(IntegrationToolApprovalUnavailableError);
  });
});

describe('listPendingIntegrationToolApprovals', () => {
  it('scopes pending approvals to the requester', async () => {
    const userId = await user();
    const otherId = await user();
    const sessionId = await ownedSession(userId);
    await insertPending({ sessionId, userId });
    expect(
      await listPendingIntegrationToolApprovals({ sessionId, userId: otherId }),
    ).toHaveLength(0);
    expect(
      await listPendingIntegrationToolApprovals({ sessionId, userId }),
    ).toHaveLength(1);
  });
});
