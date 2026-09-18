// pnpm --filter @roomote/api test github/__tests__/recordWebhook.test.ts

import { db, webhooks, eq, inArray, sql } from '@roomote/db/server';

import { recordWebhook } from '../recordWebhook';

describe('recordWebhook', () => {
  const testDeliveryIds: string[] = [];
  let terminalFailureTriggerInstalled = false;

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
    if (terminalFailureTriggerInstalled) {
      await db.execute(
        sql`DROP TRIGGER test_fail_github_webhook_terminal_update ON webhooks`,
      );
      await db.execute(
        sql`DROP FUNCTION test_fail_github_webhook_terminal_update()`,
      );
      terminalFailureTriggerInstalled = false;
    }
    vi.restoreAllMocks();
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
    expect(webhook!.error).toBeNull();
  });

  it('stores the payload with sensitive fields redacted, untouched for the handler', async () => {
    const deliveryId = `test-delivery-${Date.now()}-redaction`;
    testDeliveryIds.push(deliveryId);

    const payload = {
      action: 'created',
      hook: { config: { url: 'https://example.com', secret: 'hunter2' } },
    };
    let handlerPayloadSecret: string | undefined;

    await recordWebhook(deliveryId, 'meta.created', payload, async () => {
      // Handlers close over the original payload; redaction must only
      // affect the stored copy.
      handlerPayloadSecret = payload.hook.config.secret;
      return { status: 'ok' };
    });

    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));

    expect(handlerPayloadSecret).toBe('hunter2');
    expect(webhook!.payload).toEqual({
      action: 'created',
      hook: { config: { url: 'https://example.com', secret: '[REDACTED]' } },
    });
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

  it.each([
    {
      outcome: 'successful GitHub',
      provider: 'github' as const,
      response: { status: 'ok' as const },
    },
    {
      outcome: 'failed GitLab',
      provider: 'gitlab' as const,
      response: { status: 'error' as const, message: 'handler failed' },
    },
  ])(
    'finalizes an unclassified placeholder after a $outcome handler without replay',
    async ({ provider, response }) => {
      const deliveryId = `test-delivery-${Date.now()}-${response.status}-unclassified-placeholder`;
      testDeliveryIds.push(deliveryId);
      const handler = vi.fn(async () => response);
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await db.execute(
        sql.raw(`
      CREATE FUNCTION test_fail_github_webhook_terminal_update()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.delivery_id = '${deliveryId}'
          AND (NEW.succeeded_at IS NOT NULL OR NEW.failed_at IS NOT NULL)
        THEN
          RAISE EXCEPTION 'terminal update failed';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `),
      );
      await db.execute(sql`
      CREATE TRIGGER test_fail_github_webhook_terminal_update
      BEFORE UPDATE ON webhooks
      FOR EACH ROW EXECUTE FUNCTION test_fail_github_webhook_terminal_update()
    `);
      terminalFailureTriggerInstalled = true;

      await recordWebhook(
        deliveryId,
        'pull_request.opened',
        { test: 'first' },
        handler,
        { provider },
      );

      await db.execute(
        sql`DROP TRIGGER test_fail_github_webhook_terminal_update ON webhooks`,
      );
      await db.execute(
        sql`DROP FUNCTION test_fail_github_webhook_terminal_update()`,
      );
      terminalFailureTriggerInstalled = false;

      await recordWebhook(
        deliveryId,
        'pull_request.opened',
        { test: 'redelivery' },
        handler,
        { provider },
      );

      const [webhook] = await db
        .select()
        .from(webhooks)
        .where(eq(webhooks.deliveryId, deliveryId));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(webhook!.succeededAt).toBeNull();
      expect(webhook!.failedAt).not.toBeNull();
      expect(webhook!.error).toContain('outcome is unknown');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `[recordWebhook] Failed to update webhook ${deliveryId} for event pull_request.opened:`,
        expect.any(String),
      );
    },
  );

  it('lets the original result replace concurrent redelivery recovery without replay', async () => {
    const deliveryId = `test-delivery-${Date.now()}-concurrent`;
    testDeliveryIds.push(deliveryId);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseHandler!: () => void;
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handler = vi.fn(async () => {
      handlerStarted();
      await release;
      return { status: 'ok' as const };
    });

    const firstDelivery = recordWebhook(
      deliveryId,
      'pull_request.opened',
      { test: 'first' },
      handler,
    );
    await started;
    await recordWebhook(
      deliveryId,
      'pull_request.opened',
      { test: 'concurrent' },
      handler,
    );

    const [inProgress] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));
    expect(inProgress!.succeededAt).toBeNull();
    expect(inProgress!.failedAt).not.toBeNull();
    expect(inProgress!.error).toContain('outcome is unknown');

    releaseHandler();
    await firstDelivery;

    const [completed] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, deliveryId));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(completed!.succeededAt).not.toBeNull();
    expect(completed!.failedAt).toBeNull();
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
