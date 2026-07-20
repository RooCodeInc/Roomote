import { describe, expect, it, vi } from 'vitest';

import type { DatabaseOrTransaction } from '../../db';
import { upsertAutomation } from '../automations';
import type { AutomationTarget } from '@roomote/types';

function buildFakeTx(existingTargets: AutomationTarget[] | null) {
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const findFirst = vi.fn(async () =>
    existingTargets === null ? undefined : { targets: existingTargets },
  );

  const tx = {
    insert,
    query: { automations: { findFirst } },
  } as unknown as DatabaseOrTransaction;

  return { tx, values, findFirst };
}

const teamsTarget: AutomationTarget = {
  provider: 'teams',
  targetKind: 'teams_channel',
  externalRef: '19:conversation@thread.v2',
};

const slackTarget: AutomationTarget = {
  provider: 'slack',
  targetKind: 'slack_channel',
  externalRef: 'C123',
};

describe('upsertAutomation target preservation', () => {
  it('preserves targets of unmanaged kinds when managedTargetKinds is set', async () => {
    const { tx, values } = buildFakeTx([
      { ...slackTarget, externalRef: 'C_OLD' },
      teamsTarget,
    ]);

    await upsertAutomation(tx, {
      key: 'announcer',
      enabled: true,
      targets: [slackTarget],
      managedTargetKinds: ['slack_channel'],
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [teamsTarget, slackTarget],
      }),
    );
  });

  it('replaces targets wholesale when managedTargetKinds is omitted', async () => {
    const { tx, values, findFirst } = buildFakeTx([teamsTarget]);

    await upsertAutomation(tx, {
      key: 'announcer',
      enabled: true,
      targets: [slackTarget],
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ targets: [slackTarget] }),
    );
  });

  it('clears managed kinds while preserving others when the new list is empty', async () => {
    const { tx, values } = buildFakeTx([slackTarget, teamsTarget]);

    await upsertAutomation(tx, {
      key: 'announcer',
      enabled: false,
      targets: [],
      managedTargetKinds: ['slack_channel'],
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ targets: [teamsTarget] }),
    );
  });

  it('handles a missing existing row', async () => {
    const { tx, values } = buildFakeTx(null);

    await upsertAutomation(tx, {
      key: 'announcer',
      enabled: true,
      targets: [slackTarget],
      managedTargetKinds: ['slack_channel'],
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ targets: [slackTarget] }),
    );
  });

  it('merges sticky Telegram topic ids that the next write omitted', async () => {
    const priorTelegram: AutomationTarget = {
      provider: 'telegram',
      targetKind: 'telegram_chat',
      externalRef: '-100123',
      metadata: { threadId: 'topic-7', topicName: 'Suggest Ideas' },
    };
    const nextTelegram: AutomationTarget = {
      provider: 'telegram',
      targetKind: 'telegram_chat',
      externalRef: '-100123',
      metadata: { topicName: 'Suggest Ideas' },
    };
    const { tx, values } = buildFakeTx([priorTelegram]);

    await upsertAutomation(tx, {
      key: 'suggester',
      enabled: true,
      targets: [nextTelegram],
      managedTargetKinds: ['telegram_chat', 'slack_channel', 'discord_channel'],
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          {
            provider: 'telegram',
            targetKind: 'telegram_chat',
            externalRef: '-100123',
            metadata: {
              topicName: 'Suggest Ideas',
              threadId: 'topic-7',
            },
          },
        ],
      }),
    );
  });
});
