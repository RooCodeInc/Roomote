import type { DatabaseOrTransaction } from '../db';
import {
  getDeploymentAccountLinkHelpText,
  setDeploymentAccountLinkHelpText,
} from './account-link-help-settings';

function executorWithMetadata(metadata: Record<string, unknown> | null) {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });

  return {
    executor: {
      query: {
        deploymentSettings: {
          findFirst: vi.fn().mockResolvedValue(metadata ? { metadata } : null),
        },
      },
      update,
    } as unknown as DatabaseOrTransaction,
    set,
  };
}

describe('account link help settings', () => {
  it('returns normalized help text when configured', async () => {
    const { executor } = executorWithMetadata({
      account_link_help_text: '  Ask an admin for an invite.  ',
    });

    await expect(getDeploymentAccountLinkHelpText({ executor })).resolves.toBe(
      'Ask an admin for an invite.',
    );
  });

  it('returns null when the setting is absent or blank', async () => {
    const absent = executorWithMetadata(null);
    const blank = executorWithMetadata({ account_link_help_text: '   ' });

    await expect(
      getDeploymentAccountLinkHelpText({ executor: absent.executor }),
    ).resolves.toBeNull();
    await expect(
      getDeploymentAccountLinkHelpText({ executor: blank.executor }),
    ).resolves.toBeNull();
  });

  it('normalizes the persisted value', async () => {
    const { executor, set } = executorWithMetadata(null);

    await expect(
      setDeploymentAccountLinkHelpText('  Ask an admin.  ', { executor }),
    ).resolves.toBe('Ask an admin.');
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: expect.any(Date) }),
    );

    await expect(
      setDeploymentAccountLinkHelpText('   ', { executor }),
    ).resolves.toBeNull();
  });
});
