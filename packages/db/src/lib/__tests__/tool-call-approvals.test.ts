import {
  db,
  eq,
  sessionFactory,
  sessions,
  toolCallApprovals,
  userFactory,
} from '../../server';
import {
  consumeToolCallApproval,
  decideToolCallApproval,
  expireToolCallApproval,
  fingerprintToolCallArgs,
  getToolCallApproval,
  insertToolCallApproval,
  listPendingToolCallApprovals,
  redactToolCallArgs,
  ToolCallApprovalUnavailableError,
} from '../tool-call-approvals';

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

const call = {
  integrationId: 'mockslack',
  toolName: 'post_to_channel',
  args: { channel: 'C123', text: 'hello' },
};

function fingerprint(args: unknown = call.args) {
  return fingerprintToolCallArgs({ ...call, args });
}

async function insertPending(
  context: { sessionId: string; userId: string },
  args: unknown = call.args,
) {
  return insertToolCallApproval(context, {
    integrationId: call.integrationId,
    toolName: call.toolName,
    argsFingerprint: fingerprint(args),
    argsSummary: args,
  });
}

afterAll(async () => {
  if (sessionIds.length > 0) {
    await db
      .delete(toolCallApprovals)
      .where(eq(toolCallApprovals.sessionId, sessionIds[0]!));
    for (const sessionId of sessionIds.slice(1)) {
      await db
        .delete(toolCallApprovals)
        .where(eq(toolCallApprovals.sessionId, sessionId));
    }
    await db.delete(sessions).where(eq(sessions.id, sessionIds[0]!));
    for (const sessionId of sessionIds.slice(1)) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    }
  }
});

describe('fingerprintToolCallArgs', () => {
  it('is stable across argument key order and changes with the arguments', () => {
    const first = fingerprintToolCallArgs({
      ...call,
      args: { text: 'hello', channel: 'C123' },
    });
    expect(first).toBe(fingerprint());
    expect(fingerprint({ channel: 'C123', text: 'changed' })).not.toBe(first);
  });
});

describe('redactToolCallArgs', () => {
  it('redacts secret-looking keys and truncates oversized strings', () => {
    const redacted = redactToolCallArgs({
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

describe('insertToolCallApproval', () => {
  it('creates a pending approval bound to the session owner', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    expect(approval.status).toBe('pending');
    expect(approval.integrationId).toBe(call.integrationId);
    expect(Date.parse(approval.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('reuses the identical open ask instead of stacking duplicates', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const first = await insertPending({ sessionId, userId });
    const second = await insertPending({ sessionId, userId });
    expect(second.approvalId).toBe(first.approvalId);
    expect(
      (await listPendingToolCallApprovals({ sessionId, userId })).length,
    ).toBe(1);
  });

  it('treats changed arguments as a different call needing its own approval', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const first = await insertPending({ sessionId, userId });
    const second = await insertPending(
      { sessionId, userId },
      { channel: 'C123', text: 'changed' },
    );
    expect(second.approvalId).not.toBe(first.approvalId);
  });

  it('rejects insertions for a session the user does not own', async () => {
    const ownerId = await user();
    const otherId = await user();
    const sessionId = await ownedSession(ownerId);
    await expect(insertPending({ sessionId, userId: otherId })).rejects.toThrow(
      ToolCallApprovalUnavailableError,
    );
  });
});

describe('decideToolCallApproval', () => {
  it('lets the requester approve exactly once', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    const decided = await decideToolCallApproval(
      { sessionId, userId },
      { approvalId: approval.approvalId, decision: 'approved' },
    );
    expect(decided.status).toBe('approved');
    // Duplicate response: the decided row no longer matches the conditional update.
    await expect(
      decideToolCallApproval(
        { sessionId, userId },
        { approvalId: approval.approvalId, decision: 'rejected' },
      ),
    ).rejects.toThrow(ToolCallApprovalUnavailableError);
  });

  it('lets the requester reject', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    const decided = await decideToolCallApproval(
      { sessionId, userId },
      { approvalId: approval.approvalId, decision: 'rejected' },
    );
    expect(decided.status).toBe('rejected');
  });

  it('fails closed for a wrong approver', async () => {
    const userId = await user();
    const otherId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await expect(
      decideToolCallApproval(
        { sessionId, userId: otherId },
        { approvalId: approval.approvalId, decision: 'approved' },
      ),
    ).rejects.toThrow(ToolCallApprovalUnavailableError);
    // The wrong approver's attempt leaves the ask answerable by the requester.
    const decided = await decideToolCallApproval(
      { sessionId, userId },
      { approvalId: approval.approvalId, decision: 'approved' },
    );
    expect(decided.status).toBe('approved');
  });

  it('fails closed once the approval has expired', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await db
      .update(toolCallApprovals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(toolCallApprovals.id, approval.approvalId));
    await expect(
      decideToolCallApproval(
        { sessionId, userId },
        { approvalId: approval.approvalId, decision: 'approved' },
      ),
    ).rejects.toThrow(ToolCallApprovalUnavailableError);
  });
});

describe('consumeToolCallApproval', () => {
  it('consumes an approved call once and binds the exact arguments', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await decideToolCallApproval(
      { sessionId, userId },
      { approvalId: approval.approvalId, decision: 'approved' },
    );
    // Changed arguments never match the approved fingerprint.
    await expect(
      consumeToolCallApproval({
        approvalId: approval.approvalId,
        requesterUserId: userId,
        argsFingerprint: fingerprint({ channel: 'C123', text: 'changed' }),
      }),
    ).resolves.toBe(false);
    await expect(
      consumeToolCallApproval({
        approvalId: approval.approvalId,
        requesterUserId: userId,
        argsFingerprint: fingerprint(),
      }),
    ).resolves.toBe(true);
    // Duplicate execution: the consumed row cannot authorize a second run.
    await expect(
      consumeToolCallApproval({
        approvalId: approval.approvalId,
        requesterUserId: userId,
        argsFingerprint: fingerprint(),
      }),
    ).resolves.toBe(false);
    const row = await getToolCallApproval(approval.approvalId);
    expect(row?.status).toBe('consumed');
  });

  it('never consumes a pending or rejected approval', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await expect(
      consumeToolCallApproval({
        approvalId: approval.approvalId,
        requesterUserId: userId,
        argsFingerprint: fingerprint(),
      }),
    ).resolves.toBe(false);
  });
});

describe('expireToolCallApproval', () => {
  it('fails an unanswered approval closed and hides it from pending lists', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const approval = await insertPending({ sessionId, userId });
    await expireToolCallApproval(approval.approvalId);
    const row = await getToolCallApproval(approval.approvalId);
    expect(row?.status).toBe('expired');
    expect(
      await listPendingToolCallApprovals({ sessionId, userId }),
    ).toHaveLength(0);
    await expect(
      decideToolCallApproval(
        { sessionId, userId },
        { approvalId: approval.approvalId, decision: 'approved' },
      ),
    ).rejects.toThrow(ToolCallApprovalUnavailableError);
  });
});

describe('listPendingToolCallApprovals', () => {
  it('scopes pending approvals to the requester', async () => {
    const userId = await user();
    const otherId = await user();
    const sessionId = await ownedSession(userId);
    await insertPending({ sessionId, userId });
    expect(
      await listPendingToolCallApprovals({ sessionId, userId: otherId }),
    ).toHaveLength(0);
    expect(
      await listPendingToolCallApprovals({ sessionId, userId }),
    ).toHaveLength(1);
  });
});
