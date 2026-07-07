import { postgres, drizzle } from '@roomote/db/server';
import { config } from '../config';
import * as schema from '@roomote/db/server';

const client = postgres(config.DATABASE_URL, {
  max: 10,
});

export const db = drizzle(client, { schema });
