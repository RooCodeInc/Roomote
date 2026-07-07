import { toNextJsHandler } from 'better-auth/next-js';

import { handleAuthRequest } from '@/lib/server/auth';

export const { GET, POST } = toNextJsHandler(handleAuthRequest);
