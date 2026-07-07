import { Hono } from 'hono';

import type { Variables } from '../../types';
import { createEnvironment } from './createEnvironment';
import { getEnvironment } from './getEnvironment';
import { updateEnvironment } from './updateEnvironment';
import { listEnvironments } from './listEnvironments';

export const environmentsRouter = new Hono<{ Variables: Variables }>();

environmentsRouter.post('/', createEnvironment);
environmentsRouter.patch('/:id', updateEnvironment);
environmentsRouter.get('/:id', getEnvironment);
environmentsRouter.get('/', listEnvironments);
