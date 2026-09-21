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
  claimAutoApprovedIntegrationToolApproval,
  decideIntegrationToolApproval,
  expireIntegrationToolApproval,
  fingerprintIntegrationToolCall,
  getIntegrationToolApproval,
  insertAutoApprovedIntegrationToolApproval,
  insertIntegrationToolApproval,
  IntegrationToolApprovalUnavailableError,
  listIntegrationToolPolicies,
  listIntegrationToolSessionOverrides,
  listIntegrationToolSessionOverridesForRequester,
  listPendingIntegrationToolApprovals,
  markIntegrationToolApprovalConsumed,
  redactIntegrationToolArgs,
  setIntegrationToolSessionOverride,
  upsertIntegrationToolPolicy,
  upsertIntegrationToolUserPolicy,
  listIntegrationToolUserPolicies,
} from '../integration-tool-approvals';
import {
  isDeploymentExperimentEnabledWithShareLock,
  setDeploymentExperimentEnabled,
} from '../deployment-experiments';

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

// Claims only succeed while the experiment is on; each test starts from the
// enabled state and the disable cases turn it off themselves.
beforeEach(async () => {
  await setDeploymentExperimentEnabled('integrationToolApprovals', true);
});

afterAll(async () => {
  await setDeploymentExperimentEnabled('integrationToolApprovals', false);
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
});

describe('personal integration tool policies', () => {
  it("keeps each user's modes separate and deletes on reset to allow", async () => {
    const first = await user();
    const second = await user();
    await upsertIntegrationToolUserPolicy({
      userId: first,
      integrationId: 'my-server',
      toolName: 'delete_page',
      mode: 'ask',
    });
    await upsertIntegrationToolUserPolicy({
      userId: first,
      integrationId: 'my-server',
      toolName: 'delete_page',
      mode: 'reject',
    });
    await upsertIntegrationToolUserPolicy({
      userId: second,
      integrationId: 'my-server',
      toolName: 'delete_page',
      mode: 'ask',
    });
    expect(
      (await listIntegrationToolUserPolicies(first)).map((p) => p.mode),
    ).toEqual(['reject']);
    expect(
      (await listIntegrationToolUserPolicies(second)).map((p) => p.mode),
    ).toEqual(['ask']);

    await upsertIntegrationToolUserPolicy({
      userId: first,
      integrationId: 'my-server',
      toolName: 'delete_page',
      mode: 'allow',
    });
    expect(await listIntegrationToolUserPolicies(first)).toEqual([]);
    expect(await listIntegrationToolUserPolicies(second)).toHaveLength(1);
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

describe('claims serialize against the experiment toggle', () => {
  async function approvedManualRow(context: {
    sessionId: string;
    userId: string;
  }) {
    const pending = await insertPending(context);
    await decideIntegrationToolApproval(context, {
      approvalId: pending.approvalId,
      decision: 'approved',
    });
    return pending.approvalId;
  }

  async function reservedAutoRow(context: {
    sessionId: string;
    userId: string;
  }) {
    const reservation = await insertAutoApprovedIntegrationToolApproval(
      context,
      {
        integrationId: call.integrationId,
        toolName: call.toolName,
        nativeRequestId: nextNativeRequestId(),
        argsFingerprint: fingerprint(),
        argsSummary: call.args,
      },
    );
    return reservation.approvalId;
  }

  it('never claims once the disable has committed, even before its sweep runs', async () => {
    // The toggle commits `enabled=false` first and sweeps second. A claim
    // landing in between used to win and relay under a disabled experiment.
    const userId = await user();
    const context = { sessionId: await ownedSession(userId), userId };
    const manual = await approvedManualRow(context);
    const auto = await reservedAutoRow(context);

    await setDeploymentExperimentEnabled('integrationToolApprovals', false);

    await expect(
      markIntegrationToolApprovalConsumed({
        approvalId: manual,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);
    await expect(
      claimAutoApprovedIntegrationToolApproval({
        approvalId: auto,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);

    // The late sweep still finds both rows open and records the truth.
    await cancelOpenIntegrationToolApprovals('experiment_disabled');
    expect((await getIntegrationToolApproval(manual))?.status).toBe(
      'cancelled',
    );
    expect((await getIntegrationToolApproval(auto))?.status).toBe('cancelled');
  });

  it('never claims a reservation inserted after the disable sweep already ran', async () => {
    // The sweep only cancels rows that exist; a reservation written after it
    // can only be stopped by the claim itself reading the experiment.
    const userId = await user();
    const context = { sessionId: await ownedSession(userId), userId };
    await setDeploymentExperimentEnabled('integrationToolApprovals', false);
    await cancelOpenIntegrationToolApprovals('experiment_disabled');

    const auto = await reservedAutoRow(context);
    await expect(
      claimAutoApprovedIntegrationToolApproval({
        approvalId: auto,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);
    expect((await getIntegrationToolApproval(auto))?.status).toBe('approved');
  });

  it('makes a concurrent disable wait for an in-flight claim instead of interleaving', async () => {
    const userId = await user();
    const context = { sessionId: await ownedSession(userId), userId };
    const auto = await reservedAutoRow(context);

    // Hold the same share lock the claim takes, then start a disable: it
    // must block on the settings row until the lock holder commits.
    let disableSettled = false;
    let disable: Promise<unknown> = Promise.resolve();
    await db.transaction(async (tx) => {
      expect(
        await isDeploymentExperimentEnabledWithShareLock(
          'integrationToolApprovals',
          tx,
        ),
      ).toBe(true);
      disable = setDeploymentExperimentEnabled(
        'integrationToolApprovals',
        false,
      ).then(() => {
        disableSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(disableSettled).toBe(false);
    });
    await disable;
    expect(disableSettled).toBe(true);

    // With the disable committed, the reservation can no longer be claimed.
    await expect(
      claimAutoApprovedIntegrationToolApproval({
        approvalId: auto,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);
  });
});

describe('auto-approved reservations', () => {
  it('inserts an unrelayed approved decision and claims it exactly once', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const reservation = await insertAutoApprovedIntegrationToolApproval(
      { sessionId, userId },
      {
        integrationId: call.integrationId,
        toolName: call.toolName,
        nativeRequestId: nextNativeRequestId(),
        argsFingerprint: fingerprint(),
        argsSummary: call.args,
      },
    );
    // Unrelayed: the row is an ordinary approved decision the disable sweep
    // can still cancel, never a terminal auto_approved record yet.
    expect(reservation.status).toBe('approved');
    await expect(
      claimAutoApprovedIntegrationToolApproval({
        approvalId: reservation.approvalId,
        requesterUserId: userId,
      }),
    ).resolves.toBe(true);
    expect(
      (await getIntegrationToolApproval(reservation.approvalId))?.status,
    ).toBe('auto_approved');
    // A second claim matches nothing: the reservation is terminal.
    await expect(
      claimAutoApprovedIntegrationToolApproval({
        approvalId: reservation.approvalId,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);
  });

  it('fails the claim when the disable sweep cancels the reservation first', async () => {
    const userId = await user();
    const sessionId = await ownedSession(userId);
    const reservation = await insertAutoApprovedIntegrationToolApproval(
      { sessionId, userId },
      {
        integrationId: call.integrationId,
        toolName: call.toolName,
        nativeRequestId: nextNativeRequestId(),
        argsFingerprint: fingerprint(),
        argsSummary: call.args,
      },
    );
    await cancelOpenIntegrationToolApprovals('experiment_disabled');
    await expect(
      claimAutoApprovedIntegrationToolApproval({
        approvalId: reservation.approvalId,
        requesterUserId: userId,
      }),
    ).resolves.toBe(false);
    // The audit tells the truth: cancelled, never auto_approved.
    const row = await getIntegrationToolApproval(reservation.approvalId);
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelReason).toBe('experiment_disabled');
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

describe('integration tool session overrides', () => {
  const tool = { integrationId: call.integrationId, toolName: call.toolName };

  it('records an allow override when the requester approves for the session', async () => {
    const userId = await user();
    const context = { sessionId: await ownedSession(userId), userId };
    const pending = await insertPending(context);

    const decided = await decideIntegrationToolApproval(context, {
      approvalId: pending.approvalId,
      decision: 'approved_for_session',
    });

    // The paused call still relays through the ordinary approved → consumed
    // path; the override only affects later asks.
    expect(decided.status).toBe('approved');
    expect(
      await listIntegrationToolSessionOverrides(context.sessionId),
    ).toEqual([{ ...tool, mode: 'allow' }]);
  });

  it('never records an override from a wrong approver or a plain decision', async () => {
    const userId = await user();
    const context = { sessionId: await ownedSession(userId), userId };
    const pending = await insertPending(context);

    await expect(
      decideIntegrationToolApproval(
        { sessionId: context.sessionId, userId: await user() },
        { approvalId: pending.approvalId, decision: 'approved_for_session' },
      ),
    ).rejects.toBeInstanceOf(IntegrationToolApprovalUnavailableError);
    await decideIntegrationToolApproval(context, {
      approvalId: pending.approvalId,
      decision: 'approved',
    });

    expect(
      await listIntegrationToolSessionOverrides(context.sessionId),
    ).toEqual([]);
  });

  it('lets only the Session owner set, change, and clear an override', async () => {
    const userId = await user();
    const context = { sessionId: await ownedSession(userId), userId };
    const stranger = { sessionId: context.sessionId, userId: await user() };

    await expect(
      setIntegrationToolSessionOverride(stranger, { ...tool, mode: 'ask' }),
    ).rejects.toBeInstanceOf(IntegrationToolApprovalUnavailableError);

    await setIntegrationToolSessionOverride(context, { ...tool, mode: 'ask' });
    await setIntegrationToolSessionOverride(context, {
      ...tool,
      mode: 'allow',
    });
    expect(
      await listIntegrationToolSessionOverridesForRequester(context),
    ).toEqual([{ ...tool, mode: 'allow' }]);
    expect(
      await listIntegrationToolSessionOverridesForRequester(stranger),
    ).toEqual([]);

    await setIntegrationToolSessionOverride(context, { ...tool, mode: null });
    expect(
      await listIntegrationToolSessionOverrides(context.sessionId),
    ).toEqual([]);
  });

  it('keeps overrides inside their own session and cascades with it', async () => {
    const userId = await user();
    const first = { sessionId: await ownedSession(userId), userId };
    const second = { sessionId: await ownedSession(userId), userId };
    await setIntegrationToolSessionOverride(first, { ...tool, mode: 'allow' });

    expect(await listIntegrationToolSessionOverrides(second.sessionId)).toEqual(
      [],
    );

    await db.delete(sessions).where(eq(sessions.id, first.sessionId));
    expect(await listIntegrationToolSessionOverrides(first.sessionId)).toEqual(
      [],
    );
  });

  it('writes auto-approved asks as terminal audit rows no decision can claim', async () => {
    const userId = await user();
    const context = { sessionId: await ownedSession(userId), userId };
    const reservation = await insertAutoApprovedIntegrationToolApproval(
      context,
      {
        ...tool,
        nativeRequestId: nextNativeRequestId(),
        argsFingerprint: fingerprint(),
        argsSummary: { channel: 'C123', apiKey: 'sk-live' },
      },
    );
    // The reservation is unrelayed until the bridge claims it atomically.
    await claimAutoApprovedIntegrationToolApproval({
      approvalId: reservation.approvalId,
      requesterUserId: userId,
    });

    const [row] = await db
      .select()
      .from(integrationToolApprovalRequests)
      .where(eq(integrationToolApprovalRequests.sessionId, context.sessionId));
    expect(row?.status).toBe('auto_approved');
    expect(row?.argsSummary).toEqual({ channel: 'C123', apiKey: '[redacted]' });
    expect(await listPendingIntegrationToolApprovals(context)).toEqual([]);
    expect(
      await markIntegrationToolApprovalConsumed({
        approvalId: row!.id,
        requesterUserId: userId,
      }),
    ).toBe(false);
    await expect(
      decideIntegrationToolApproval(context, {
        approvalId: row!.id,
        decision: 'approved',
      }),
    ).rejects.toBeInstanceOf(IntegrationToolApprovalUnavailableError);
  });
});
