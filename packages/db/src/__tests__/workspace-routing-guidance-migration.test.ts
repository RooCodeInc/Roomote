import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db, sql } from '../server';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/0082_workspace_routing_guidance.sql', import.meta.url),
);

describe('workspace routing guidance migration', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  it('converts legacy rules once without overwriting text guidance', async () => {
    const schemaName = `workspace_routing_${randomUUID().replaceAll('-', '')}`;
    const environmentId = randomUUID();
    const missingEnvironmentId = randomUUID();

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
        await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`));
        await tx.execute(
          sql.raw(
            'CREATE TABLE "environments" ("id" uuid PRIMARY KEY, "name" text NOT NULL)',
          ),
        );
        await tx.execute(
          sql.raw(
            'CREATE TABLE "deployment_settings" ("id" text PRIMARY KEY, "workspace_routing_settings" jsonb)',
          ),
        );
        await tx.execute(sql`
          INSERT INTO "environments" ("id", "name")
          VALUES (${environmentId}::uuid, 'Hospital app')
        `);
        await tx.execute(sql`
          INSERT INTO "deployment_settings" ("id", "workspace_routing_settings")
          VALUES
            ('legacy', ${JSON.stringify({
              rules: [
                {
                  description: 'Messages from hospital-bugs belong here.',
                  target: environmentId,
                },
                {
                  description:
                    'Cross-repository migrations use the broad scope.',
                  target: '__all_repositories__',
                },
                {
                  description: 'Keep the unavailable target visible.',
                  target: missingEnvironmentId,
                },
              ],
            })}::jsonb),
            ('text', ${JSON.stringify({
              guidance: 'Keep this existing guidance.',
              rules: [{ description: 'Old fallback.', target: environmentId }],
            })}::jsonb)
        `);

        await tx.execute(sql.raw(migration));
        const firstRun = await tx.execute<{
          id: string;
          workspace_routing_settings: unknown;
        }>(sql`
          SELECT "id", "workspace_routing_settings"
          FROM "deployment_settings"
          ORDER BY "id"
        `);

        expect(firstRun).toEqual([
          {
            id: 'legacy',
            workspace_routing_settings: {
              guidance: [
                '- Messages from hospital-bugs belong here. -> Use the "Hospital app" environment.',
                '- Cross-repository migrations use the broad scope. -> Use All repositories.',
                `- Keep the unavailable target visible. -> Use environment "${missingEnvironmentId}".`,
              ].join('\n'),
              rules: [
                {
                  description: 'Messages from hospital-bugs belong here.',
                  target: environmentId,
                },
                {
                  description:
                    'Cross-repository migrations use the broad scope.',
                  target: '__all_repositories__',
                },
                {
                  description: 'Keep the unavailable target visible.',
                  target: missingEnvironmentId,
                },
              ],
            },
          },
          {
            id: 'text',
            workspace_routing_settings: {
              guidance: 'Keep this existing guidance.',
              rules: [{ description: 'Old fallback.', target: environmentId }],
            },
          },
        ]);

        await tx.execute(sql.raw(migration));
        const secondRun = await tx.execute(sql`
          SELECT "id", "workspace_routing_settings"
          FROM "deployment_settings"
          ORDER BY "id"
        `);
        expect(secondRun).toEqual(firstRun);
      });
    } finally {
      await db.execute(
        sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`),
      );
    }
  });
});
