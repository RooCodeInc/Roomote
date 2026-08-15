import { Hono } from 'hono';

import type { Variables } from '../../types';
import { createEnvironment } from './createEnvironment';
import { updateEnvironment } from './updateEnvironment';
import { listEnvironments } from './listEnvironments';
import { recordVerification } from './recordVerification';

export const environmentsRouter = new Hono<{ Variables: Variables }>();

environmentsRouter.post('/', createEnvironment);
environmentsRouter.patch('/:id', updateEnvironment);
environmentsRouter.post('/:id/verification', recordVerification);
environmentsRouter.get('/', listEnvironments);
