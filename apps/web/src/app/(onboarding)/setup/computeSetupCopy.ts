import type { ComputeProvider } from '@roomote/types';

type ComputeCredentialsHintSegment = string | { label: string; href: string };

/**
 * Optional, provider-specific guidance appended to the compute config step's
 * intro paragraph, telling operators how to create an account and where to
 * find the credentials the step asks for. Link segments render as external
 * links.
 */
const COMPUTE_CREDENTIALS_HINTS: Partial<
  Record<ComputeProvider, readonly ComputeCredentialsHintSegment[]>
> = {
  modal: [
    'Generate a token ID and secret from the ',
    { label: 'API tokens page', href: 'https://modal.com/settings/tokens' },
    ' in your workspace settings.',
  ],
  e2b: [
    'Copy a team API key from the ',
    {
      label: 'Keys tab',
      href: 'https://e2b.dev/dashboard?tab=keys',
    },
    ' of the dashboard.',
  ],
  daytona: [
    'Create an API key with write and delete permissions on Sandboxes and Snapshots (no other scopes needed) from the ',
    {
      label: 'API Keys page',
      href: 'https://app.daytona.io/dashboard/keys',
    },
    '.',
  ],
  blaxel: [
    'Create an API key in the ',
    {
      label: 'API keys page',
      href: 'https://app.blaxel.ai/profile/security',
    },
    ' and copy your workspace name from the console URL.',
  ],
};

export function getComputeCredentialsHint(
  provider: ComputeProvider,
): readonly ComputeCredentialsHintSegment[] | null {
  return COMPUTE_CREDENTIALS_HINTS[provider] ?? null;
}
