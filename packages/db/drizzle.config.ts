import { defineConfig } from 'drizzle-kit';

import { Env } from '@roomote/env';

import { assertSafeTestDatabaseUrl } from './src/db';

if (process.env.NODE_ENV === 'test') {
  assertSafeTestDatabaseUrl(Env.DATABASE_URL, 'test');
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: Env.DATABASE_URL,
  },
});
