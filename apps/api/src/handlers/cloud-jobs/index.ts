import { Hono } from 'hono';

import type { Variables } from '../../types';
import { getCloudJobLogs } from './logs';

export const cloudJobsRouter = new Hono<{ Variables: Variables }>();

cloudJobsRouter.get('/:id/logs', getCloudJobLogs);
