import { db, webhooks, eq, inArray, sql } from '@roomote/db/server';

import { recordLinearWebhook } from '../recordWebhook';

describe('recordLinearWebhook', () => {
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
        sql`DROP TRIGGER test_fail_linear_webhook_terminal_update ON webhooks`,
      );
      await db.execute(
        sql`DROP FUNCTION test_fail_linear_webhook_terminal_update()`,
      );
      terminalFailureTriggerInstalled = false;
    }
    vi.restoreAllMocks();
    await deleteTestData();
  });

  it.each([
    { outcome: 'successful', response: { status: 'ok' as const } },
    {
      outcome: 'failed',
      response: { status: 'error' as const, message: 'handler failed' },
    },
  ])(
    'finalizes an unclassified placeholder after a $outcome handler without replay',
    async ({ response }) => {
      const webhookId = `linear-test-${Date.now()}-${response.status}-unclassified-placeholder`;
      testDeliveryIds.push(webhookId);
      const handler = vi.fn(async () => response);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await db.execute(
        sql.raw(`
      CREATE FUNCTION test_fail_linear_webhook_terminal_update()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.delivery_id = '${webhookId}'
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
      CREATE TRIGGER test_fail_linear_webhook_terminal_update
      BEFORE UPDATE ON webhooks
      FOR EACH ROW EXECUTE FUNCTION test_fail_linear_webhook_terminal_update()
    `);
      terminalFailureTriggerInstalled = true;

      await recordLinearWebhook(webhookId, 'Issue', { test: 'first' }, handler);

      await db.execute(
        sql`DROP TRIGGER test_fail_linear_webhook_terminal_update ON webhooks`,
      );
      await db.execute(
        sql`DROP FUNCTION test_fail_linear_webhook_terminal_update()`,
      );
      terminalFailureTriggerInstalled = false;

      await recordLinearWebhook(
        webhookId,
        'Issue',
        { test: 'redelivery' },
        handler,
      );

      const [webhook] = await db
        .select()
        .from(webhooks)
        .where(eq(webhooks.deliveryId, webhookId));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(webhook!.succeededAt).toBeNull();
      expect(webhook!.failedAt).not.toBeNull();
      expect(webhook!.error).toContain('outcome is unknown');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `[recordLinearWebhook] Failed to update webhook ${webhookId} for event Issue:`,
        expect.any(String),
      );
    },
  );

  it('suppresses normal duplicate deliveries', async () => {
    const webhookId = `linear-test-${Date.now()}-duplicate`;
    testDeliveryIds.push(webhookId);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = vi.fn(async () => ({ status: 'ok' as const }));

    await recordLinearWebhook(webhookId, 'Issue', { test: 'first' }, handler);
    await recordLinearWebhook(
      webhookId,
      'Issue',
      { test: 'duplicate' },
      handler,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('lets the original result replace concurrent redelivery recovery without replay', async () => {
    const webhookId = `linear-test-${Date.now()}-concurrent`;
    testDeliveryIds.push(webhookId);
    vi.spyOn(console, 'log').mockImplementation(() => {});
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

    const firstDelivery = recordLinearWebhook(
      webhookId,
      'Issue',
      { test: 'first' },
      handler,
    );
    await started;
    await recordLinearWebhook(
      webhookId,
      'Issue',
      { test: 'concurrent' },
      handler,
    );

    const [inProgress] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, webhookId));
    expect(inProgress!.succeededAt).toBeNull();
    expect(inProgress!.failedAt).not.toBeNull();
    expect(inProgress!.error).toContain('outcome is unknown');

    releaseHandler();
    await firstDelivery;

    const [completed] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.deliveryId, webhookId));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(completed!.succeededAt).not.toBeNull();
    expect(completed!.failedAt).toBeNull();
  });
});
