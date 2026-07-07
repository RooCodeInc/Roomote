import { z } from 'zod';

import type { AuthTokenContext } from '@roomote/types';
import * as Auth from '@roomote/auth';

export const createAuthTokenInputSchema = z.object({
  timeoutMs: Auth.publicAuthTokenTimeoutMsSchema.optional(),
});

export const createAuthToken = (
  auth: AuthTokenContext,
  input: z.infer<typeof createAuthTokenInputSchema>,
) =>
  Auth.createPublicAuthToken({
    userId: auth.userId,
    timeoutMs: input.timeoutMs,
  });
