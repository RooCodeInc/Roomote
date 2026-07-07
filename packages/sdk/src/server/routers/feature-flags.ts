import { z } from 'zod';
import {
  FeatureFlag,
  getFeatureFlagEvaluator,
} from '@roomote/feature-flags/server';
import { getRedis } from '@roomote/redis';

import { authenticatedProcedure, router } from '../trpc';

export const featureFlagsRouter = router({
  evaluate: authenticatedProcedure
    .input(
      z.object({
        flag: z.nativeEnum(FeatureFlag),
      }),
    )
    .query(async ({ input }) => {
      const evaluator = getFeatureFlagEvaluator(getRedis());
      return evaluator.evaluate(input.flag, {
        isDeploymentContext: true,
      });
    }),
});
