import { FeatureFlag } from '@roomote/feature-flags';

import { client } from './client';

export { FeatureFlag };

export const evaluate = (flag: FeatureFlag) =>
  client.featureFlags.evaluate.query({ flag });
