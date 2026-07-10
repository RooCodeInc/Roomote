import { Hono } from 'hono';

import type { Variables } from '../../types';
import { getTaskRunLogs } from './logs';

export const taskRunsRouter = new Hono<{ Variables: Variables }>();

taskRunsRouter.get('/:id/logs', getTaskRunLogs);
