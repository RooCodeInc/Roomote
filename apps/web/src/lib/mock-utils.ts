import { FeatureFlag } from '@roomote/feature-flags';

import type { UserResource } from '@/types';

export const mockFeatureFlags: Record<FeatureFlag, boolean> = {
  [FeatureFlag.SlackEvalLauncher]: false,
  [FeatureFlag.ShowDebugUISetting]: false,
  [FeatureFlag.SlackProofAutoPost]: false,
  [FeatureFlag.SuggestionRouting]: false,
  [FeatureFlag.VisualProofAutoScreencast]: false,
  [FeatureFlag.BackgroundSubagents]: false,
  [FeatureFlag.CodeMode]: false,
};

export const mockUserResource: UserResource = {
  username: 'username',
  fullName: 'John Doe',
  firstName: 'John',
  lastName: 'Doe',
  primaryEmailAddress: {
    id: 'primary-email-address-id',
    emailAddress: 'john.doe@example.com',
  },
  emailAddresses: [
    { id: 'email-address-id', emailAddress: 'john.doe@example.com' },
  ],
  imageUrl: 'https://example.com/image.jpg',
  createdAt: new Date('2025-01-01'),
};
