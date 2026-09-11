import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db, sql } from '../server';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/0086_tearful_power_pack.sql', import.meta.url),
);

describe('Automation results consolidation migration', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  it('backfills suggestions and keeps the N-1 work item bridge synchronized', async () => {
    const schemaName = `automation_results_${randomUUID().replaceAll('-', '')}`;
    const existingWorkItemId = randomUUID();
    const laterWorkItemId = randomUUID();

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
        await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`));
        await tx.execute(
          sql.raw(`
          CREATE TABLE "work_items" (
            "id" uuid PRIMARY KEY,
            "kind" text NOT NULL,
            "automation_key" text,
            "source_task_id" text,
            "title" text NOT NULL,
            "brief" text,
            "result_accepted_at" timestamp,
            "result_ignored_at" timestamp,
            "result_automation_name" text,
            "result_priority" text,
            "result_user_id" text,
            "created_at" timestamp DEFAULT now() NOT NULL,
            "updated_at" timestamp DEFAULT now() NOT NULL
          )
        `),
        );
        await tx.execute(
          sql.raw(`
          CREATE TABLE "automation_results" (
            "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
            "automation_key" text,
            "custom_automation_id" uuid,
            "source_task_id" text,
            "user_id" text,
            "automation_name" text NOT NULL,
            "content" text NOT NULL,
            "priority" text DEFAULT 'normal' NOT NULL,
            "dedupe_key" text NOT NULL UNIQUE,
            "accepted_at" timestamp,
            "ignored_at" timestamp,
            "created_at" timestamp DEFAULT now() NOT NULL,
            "updated_at" timestamp DEFAULT now() NOT NULL
          )
        `),
        );
        await tx.execute(sql`
          INSERT INTO "work_items" (
            "id", "kind", "title", "brief", "result_automation_name",
            "result_priority", "result_user_id"
          ) VALUES (
            ${existingWorkItemId}, 'suggestion', 'Existing suggestion',
            'Backfill me', 'Code Quality Auditor', 'high', 'user-1'
          )
        `);

        const statements = migration
          .replaceAll('"public".', `"${schemaName}".`)
          .split('--> statement-breakpoint')
          .map((statement) => statement.trim())
          .filter(Boolean);
        for (const statement of statements) {
          await tx.execute(sql.raw(statement));
        }

        const [backfilled] = await tx.execute<{
          source_work_item_id: string;
          kind: string;
          title: string;
          content: string;
          automation_name: string;
          priority: string;
        }>(sql`
          SELECT source_work_item_id, kind, title, content, automation_name, priority
          FROM automation_results
          WHERE source_work_item_id = ${existingWorkItemId}
        `);
        expect(backfilled).toEqual({
          source_work_item_id: existingWorkItemId,
          kind: 'suggestion',
          title: 'Existing suggestion',
          content: 'Backfill me',
          automation_name: 'Code Quality Auditor',
          priority: 'high',
        });

        await tx.execute(sql`
          UPDATE automation_results
          SET accepted_at = now(), ignored_at = NULL
          WHERE source_work_item_id = ${existingWorkItemId}
        `);
        const [compatibilityState] = await tx.execute<{
          accepted: boolean;
          ignored: boolean;
        }>(sql`
          SELECT
            result_accepted_at IS NOT NULL AS accepted,
            result_ignored_at IS NOT NULL AS ignored
          FROM work_items
          WHERE id = ${existingWorkItemId}
        `);
        expect(compatibilityState).toEqual({ accepted: true, ignored: false });

        await tx.execute(sql`
          INSERT INTO work_items (
            id, kind, title, brief, result_automation_name, result_priority
          ) VALUES (
            ${laterWorkItemId}, 'suggestion', 'Rollback suggestion',
            'Created by N-1', 'Security Auditor', 'critical'
          )
        `);
        const [bridged] = await tx.execute<{
          title: string;
          content: string;
          priority: string;
        }>(sql`
          SELECT title, content, priority
          FROM automation_results
          WHERE source_work_item_id = ${laterWorkItemId}
        `);
        expect(bridged).toEqual({
          title: 'Rollback suggestion',
          content: 'Created by N-1',
          priority: 'critical',
        });

        await tx.execute(sql`
          UPDATE work_items
          SET result_accepted_at = NULL, result_ignored_at = now()
          WHERE id = ${laterWorkItemId}
        `);
        const [canonicalState] = await tx.execute<{
          accepted: boolean;
          ignored: boolean;
        }>(sql`
          SELECT
            accepted_at IS NOT NULL AS accepted,
            ignored_at IS NOT NULL AS ignored
          FROM automation_results
          WHERE source_work_item_id = ${laterWorkItemId}
        `);
        expect(canonicalState).toEqual({ accepted: false, ignored: true });
      });
    } finally {
      await db.execute(
        sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`),
      );
    }
  });
});
