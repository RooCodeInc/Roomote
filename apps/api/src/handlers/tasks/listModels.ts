import type { Context } from 'hono';
import { getDeploymentTaskModelOptions } from '@roomote/db/server';

import type { Variables } from '../../types';

export const listTaskModels = async (c: Context<{ Variables: Variables }>) =>
  c.json(await getDeploymentTaskModelOptions());
