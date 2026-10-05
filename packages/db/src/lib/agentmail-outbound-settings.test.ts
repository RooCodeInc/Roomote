import { type DatabaseOrTransaction, db } from '../db';
import {
  getAgentMailOutboundSettings,
  isAgentMailOutboundEnabled,
  setAgentMailOutboundEnabled,
} from './agentmail-outbound-settings';

function readExecutor(emailOutboundEnabled: boolean | null) {
  return {
    query: {
      deploymentSettings: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            emailOutboundEnabled === null ? null : { emailOutboundEnabled },
          ),
      },
    },
  } as unknown as DatabaseOrTransaction;
}

describe('AgentMail outbound settings', () => {
  const originalEmailChannelEnabled = process.env.R_EMAIL_CHANNEL_ENABLED;

  afterEach(() => {
    if (originalEmailChannelEnabled === undefined) {
      delete process.env.R_EMAIL_CHANNEL_ENABLED;
    } else {
      process.env.R_EMAIL_CHANNEL_ENABLED = originalEmailChannelEnabled;
    }
  });

  it('defaults the persisted switch on and requires both gates', async () => {
    process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    await expect(
      getAgentMailOutboundSettings({ executor: readExecutor(null) }),
    ).resolves.toEqual({
      environmentEnabled: true,
      persistedEnabled: true,
      effectiveEnabled: true,
    });

    await expect(
      isAgentMailOutboundEnabled({ executor: readExecutor(false) }),
    ).resolves.toBe(false);

    process.env.R_EMAIL_CHANNEL_ENABLED = 'false';
    await expect(
      isAgentMailOutboundEnabled({ executor: readExecutor(true) }),
    ).resolves.toBe(false);
  });

  it('persists the admin switch without touching provider credentials', async () => {
    await expect(
      db.transaction(async (tx) => {
        await expect(
          setAgentMailOutboundEnabled(false, { executor: tx }),
        ).resolves.toBe(false);
        await expect(
          getAgentMailOutboundSettings({ executor: tx }),
        ).resolves.toMatchObject({ persistedEnabled: false });

        throw new Error('roll back test setting');
      }),
    ).rejects.toThrow('roll back test setting');
  });
});
