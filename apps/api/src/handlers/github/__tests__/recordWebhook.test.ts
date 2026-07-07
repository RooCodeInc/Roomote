// pnpm --filter @roomote/api test github/__tests__/recordWebhook.test.ts

import { db, webhooks, eq, inArray } from '@roomote/db/server';

import { recordWebhook } from '../recordWebhook';

describe('recordWebhook', () => {
  const testDeliveryIds: string[] = [];

  const deleteTestData = async () => {
    if (testDeliveryIds.length > 0) {
      await db
        .delete(webhooks)
        .where(inArray(webhooks.deliveryId, testDeliveryIds));
    }
  };

  beforeEach(async () => {
    await deleteTestData();
    testDeliveryIds.length = 0;
  });

  afterEach(async () => {
    await deleteTestData();
  });

  it('should record a webhook with succeededAt when handler returns ok', async () => {
    const deliveryId = `test-delivery-${Date.now()}-success`;
    testDeliveryIds.push(deliveryId);

    await recordWebhook(
      deliveryId,
      'pull_request.opened',
      { test: 'payload' },
      async () => ({ status: 'ok' }),
    );

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));

    expect(webhook).toBeDefined();
    expect(webhook!.provider).toBe('github');
    expect(webhook!.event).toBe('pull_request.opened');
    expect(webhook!.payload).toEqual({ test: 'payload' });
    expect(webhook!.succeededAt).not.toBeNull();
    expect(webhook!.failedAt).toBeNull();
    expect(webhook!.ignoredAt).toBeNull();
    expect(webhook!.error).toBeNull();
  });

  it('records a non-GitHub provider when supplied', async () => {
    const deliveryId = `test-delivery-${Date.now()}-gitlab`;
    testDeliveryIds.push(deliveryId);

    await recordWebhook(
      deliveryId,
      'merge_request.opened',
      { project: { path_with_namespace: 'group/repo' } },
      async () => ({ status: 'ok' }),
      { provider: 'gitlab' },
    );

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));

    expect(webhook).toBeDefined();
    expect(webhook!.provider).toBe('gitlab');
    expect(webhook!.event).toBe('merge_request.opened');
  });

  it('should record a webhook with failedAt and error when handler returns error', async () => {
    const deliveryId = `test-delivery-${Date.now()}-error`;
    testDeliveryIds.push(deliveryId);

    await recordWebhook(
      deliveryId,
      'pull_request.closed',
      { repo: 'test/repo' },
      async () => ({ status: 'error', message: 'Something went wrong' }),
    );

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));

    expect(webhook).toBeDefined();
    expect(webhook!.provider).toBe('github');
    expect(webhook!.event).toBe('pull_request.closed');
    expect(webhook!.payload).toEqual({ repo: 'test/repo' });
    expect(webhook!.succeededAt).toBeNull();
    expect(webhook!.failedAt).not.toBeNull();
    expect(webhook!.ignoredAt).toBeNull();
    expect(webhook!.error).toBe('Something went wrong');
  });

  it('should record a webhook with failedAt when handler throws an exception', async () => {
    const deliveryId = `test-delivery-${Date.now()}-exception`;
    testDeliveryIds.push(deliveryId);

    await recordWebhook(
      deliveryId,
      'pull_request.synchronize',
      { repo: 'test/repo' },
      async () => {
        throw new Error('Handler crashed unexpectedly');
      },
    );

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));

    expect(webhook).toBeDefined();
    expect(webhook!.provider).toBe('github');
    expect(webhook!.event).toBe('pull_request.synchronize');
    expect(webhook!.payload).toEqual({ repo: 'test/repo' });
    expect(webhook!.succeededAt).toBeNull();
    expect(webhook!.failedAt).not.toBeNull();
    expect(webhook!.ignoredAt).toBeNull();
    expect(webhook!.error).toBe('Handler crashed unexpectedly');
  });

  it('should record webhook with metadata when handler returns ok with metadata', async () => {
    const deliveryId = `test-delivery-${Date.now()}-metadata`;
    testDeliveryIds.push(deliveryId);

    await recordWebhook(
      deliveryId,
      'installation.created',
      { installation: { id: 123 } },
      async () => ({ status: 'ok', metadata: { jobIds: [1, 2, 3] } }),
    );

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));

    expect(webhook).toBeDefined();
    expect(webhook!.succeededAt).not.toBeNull();
    expect(webhook!.failedAt).toBeNull();
    expect(webhook!.error).toBeNull();
  });

  it('should handle complex payload objects', async () => {
    const deliveryId = `test-delivery-${Date.now()}-complex`;
    testDeliveryIds.push(deliveryId);

    const complexPayload = {
      action: 'opened',
      pull_request: {
        id: 12345,
        number: 42,
        title: 'Test PR',
        body: 'This is a test',
        head: { sha: 'abc123', ref: 'feature-branch' },
        base: { sha: 'def456', ref: 'main' },
      },
      repository: {
        id: 67890,
        full_name: 'test/repo',
        private: false,
      },
      sender: {
        login: 'testuser',
        id: 11111,
      },
    };

    await recordWebhook(
      deliveryId,
      'pull_request.opened',
      complexPayload,
      async () => ({ status: 'ok' }),
    );

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));

    expect(webhook).toBeDefined();
    expect(webhook!.payload).toEqual(complexPayload);
  });

  it('should skip handler execution for duplicate deliveryId (redelivery guard)', async () => {
    const deliveryId = `test-delivery-${Date.now()}-unique`;
    testDeliveryIds.push(deliveryId);

    let handlerCallCount = 0;

    // First delivery - handler should be called
    await recordWebhook(
      deliveryId,
      'pull_request.opened',
      { test: 'first' },
      async () => {
        handlerCallCount++;
        return { status: 'ok' };
      },
    );

    expect(handlerCallCount).toBe(1);

    // Second delivery (redelivery) - handler should NOT be called
    await recordWebhook(
      deliveryId,
      'pull_request.opened',
      { test: 'second' },
      async () => {
        handlerCallCount++;
        return { status: 'ok' };
      },
    );

    // Handler should still only have been called once
    expect(handlerCallCount).toBe(1);

    // Verify only one record exists
    const records = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));

    expect(records).toHaveLength(1);
    expect(records[0]!.payload).toEqual({ test: 'first' });
  });

  it('should record different event types correctly', async () => {
    const events = [
      'pull_request.opened',
      'pull_request.closed',
      'pull_request.synchronize',
      'issue_comment.created',
      'installation.created',
    ];

    for (const event of events) {
      const deliveryId = `test-delivery-${Date.now()}-${event.replace('.', '-')}`;
      testDeliveryIds.push(deliveryId);

      await recordWebhook(deliveryId, event, { event }, async () => ({
        status: 'ok',
      }));

      const [webhook] = await db
        .select()
        .from(webhooks)
        .where(eq(webhooks.deliveryId, deliveryId));

      expect(webhook).toBeDefined();
      expect(webhook!.event).toBe(event);
    }
  });
});
