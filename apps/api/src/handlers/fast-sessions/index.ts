import { Hono } from 'hono';

import type { Variables } from '../../types';
import { getFastSessionMessages } from './getMessages';
import { sendFastSessionMessage } from './sendMessage';

export const fastSessionsRouter = new Hono<{ Variables: Variables }>();

fastSessionsRouter.get('/:sessionId/messages', getFastSessionMessages);
fastSessionsRouter.post('/:sessionId/send_message', sendFastSessionMessage);
