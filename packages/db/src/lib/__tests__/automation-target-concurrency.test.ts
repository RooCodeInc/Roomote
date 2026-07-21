import { afterEach, describe, expect, it } from 'vitest';

import type { AutomationTarget } from '@roomote/types';

import { automations, db, eq } from '../../server';
import {
  persistAutomationTelegramTopicThread,
  upsertAutomation,
} from '../automations';

const AUTOMATION_KEY = 'platform_issue_alerts';
const CHAT_ID = '-100123';

describe('automation target concurrency', () => {
  afterEach(async () => {
    await db.delete(automations).where(eq(automations.key, AUTOMATION_KEY));
  });

  it('serializes a settings target merge with sticky topic persistence', async () => {
    const telegramTarget: AutomationTarget = {
      provider: 'telegram',
      targetKind: 'telegram_chat',
      externalRef: CHAT_ID,
      metadata: { topicName: 'Suggest Ideas' },
    };

    await upsertAutomation(db, {
      key: AUTOMATION_KEY,
      enabled: true,
      targets: [telegramTarget],
    });

    let persistTopic!: Promise<void>;

    await db.transaction(async (settingsTx) => {
      await upsertAutomation(settingsTx, {
        key: AUTOMATION_KEY,
        enabled: true,
        targets: [telegramTarget],
        managedTargetKinds: ['telegram_chat'],
      });

      persistTopic = persistAutomationTelegramTopicThread({
        automationKey: AUTOMATION_KEY,
        chatId: CHAT_ID,
        threadId: 'topic-7',
        topicName: 'Suggest Ideas',
      });

      const persistenceState = await Promise.race([
        persistTopic.then(() => 'completed' as const),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), 50),
        ),
      ]);
      expect(persistenceState).toBe('blocked');
    });

    await persistTopic;

    const automation = await db.query.automations.findFirst({
      columns: { targets: true },
      where: eq(automations.key, AUTOMATION_KEY),
    });
    expect(automation?.targets).toEqual([
      {
        ...telegramTarget,
        metadata: { topicName: 'Suggest Ideas', threadId: 'topic-7' },
      },
    ]);
  });
});
