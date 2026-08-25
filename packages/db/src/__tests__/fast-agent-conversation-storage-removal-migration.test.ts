import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db, sql } from '../server';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/0053_watery_shinobi_shaw.sql', import.meta.url),
);

describe('Fast conversation storage removal migration', () => {
  const migration = readFileSync(migrationPath, 'utf8');
  const statements = migration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  it('drops bridge triggers before removing legacy storage', async () => {
    const firstTableDrop = migration.indexOf('DROP TABLE');

    expect(firstTableDrop).toBeGreaterThan(-1);
    for (const trigger of [
      'serialize_canonical_fast_conversation_bridge_writes',
      'sync_canonical_fast_conversation_to_legacy',
      'serialize_legacy_fast_conversation_bridge_writes',
      'sync_legacy_fast_conversation_to_canonical',
    ]) {
      const triggerDrop = migration.indexOf(`DROP TRIGGER "${trigger}"`);
      expect(triggerDrop).toBeGreaterThan(-1);
      expect(triggerDrop).toBeLessThan(firstTableDrop);
    }
  });

  it('removes the legacy tables, foreign keys, and bridge functions', async () => {
    const schemaName = `fast_agent_storage_removal_${randomUUID().replaceAll('-', '')}`;

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
        await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`));
        await tx.execute(
          sql.raw(
            'CREATE TABLE "fast_agent_conversations" ("id" uuid PRIMARY KEY)',
          ),
        );
        await tx.execute(
          sql.raw('CREATE TABLE "slack_quick_answers" ("id" uuid PRIMARY KEY)'),
        );
        await tx.execute(
          sql.raw(`
          CREATE TABLE "fast_agent_conversation_aliases" (
            "legacy_conversation_id" uuid PRIMARY KEY
              REFERENCES "slack_quick_answers"("id"),
            "conversation_id" uuid NOT NULL
              REFERENCES "fast_agent_conversations"("id")
          )
        `),
        );
        await tx.execute(
          sql.raw(`
          CREATE TABLE "slack_conversation_messages" (
            "id" uuid PRIMARY KEY,
            "slack_quick_answer_id" uuid
              CONSTRAINT "slack_conversation_messages_slack_quick_answer_id_slack_quick_answers_id_fk"
              REFERENCES "slack_quick_answers"("id")
          )
        `),
        );
        await tx.execute(
          sql.raw(`
          CREATE TABLE "slack_fast_integration_calls" (
            "id" uuid PRIMARY KEY,
            "fast_agent_conversation_id" uuid
              REFERENCES "fast_agent_conversations"("id"),
            "slack_quick_answer_id" uuid
              CONSTRAINT "slack_fast_integration_calls_slack_quick_answer_id_slack_quick_answers_id_fk"
              REFERENCES "slack_quick_answers"("id")
          )
        `),
        );
        await tx.execute(
          sql.raw(`
          CREATE INDEX "slack_fast_integration_calls_session_idx"
          ON "slack_fast_integration_calls" ("slack_quick_answer_id")
        `),
        );

        for (const functionName of [
          'serialize_fast_conversation_bridge_writes',
          'sync_canonical_fast_conversation_to_legacy',
          'sync_legacy_fast_conversation_to_canonical',
        ]) {
          await tx.execute(
            sql.raw(`
            CREATE FUNCTION "${functionName}"()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$ BEGIN RETURN NEW; END; $$
          `),
          );
        }
        await tx.execute(
          sql.raw(`
          CREATE TRIGGER "serialize_canonical_fast_conversation_bridge_writes"
          BEFORE INSERT OR UPDATE ON "fast_agent_conversations"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "serialize_fast_conversation_bridge_writes"()
        `),
        );
        await tx.execute(
          sql.raw(`
          CREATE TRIGGER "sync_canonical_fast_conversation_to_legacy"
          AFTER INSERT OR UPDATE ON "fast_agent_conversations"
          FOR EACH ROW
          EXECUTE FUNCTION "sync_canonical_fast_conversation_to_legacy"()
        `),
        );
        await tx.execute(
          sql.raw(`
          CREATE TRIGGER "serialize_legacy_fast_conversation_bridge_writes"
          BEFORE INSERT OR UPDATE ON "slack_quick_answers"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "serialize_fast_conversation_bridge_writes"()
        `),
        );
        await tx.execute(
          sql.raw(`
          CREATE TRIGGER "sync_legacy_fast_conversation_to_canonical"
          AFTER INSERT OR UPDATE ON "slack_quick_answers"
          FOR EACH ROW
          EXECUTE FUNCTION "sync_legacy_fast_conversation_to_canonical"()
        `),
        );

        for (const statement of statements) {
          await tx.execute(sql.raw(statement));
        }

        const [tables] = await tx.execute<{
          canonical: string | null;
          aliases: string | null;
          legacy: string | null;
        }>(sql`
          SELECT
            to_regclass('fast_agent_conversations')::text AS canonical,
            to_regclass('fast_agent_conversation_aliases')::text AS aliases,
            to_regclass('slack_quick_answers')::text AS legacy
        `);
        expect(tables).toEqual({
          canonical: 'fast_agent_conversations',
          aliases: null,
          legacy: null,
        });

        const legacyColumns = await tx.execute(sql`
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = ${schemaName}
            AND column_name = 'slack_quick_answer_id'
        `);
        expect(legacyColumns).toHaveLength(0);

        const [canonicalColumn] = await tx.execute<{ is_nullable: string }>(sql`
          SELECT is_nullable
          FROM information_schema.columns
          WHERE table_schema = ${schemaName}
            AND table_name = 'slack_fast_integration_calls'
            AND column_name = 'fast_agent_conversation_id'
        `);
        expect(canonicalColumn?.is_nullable).toBe('NO');

        const bridgeFunctions = await tx.execute(sql`
          SELECT 1
          FROM pg_proc
          INNER JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
          WHERE pg_namespace.nspname = ${schemaName}
            AND pg_proc.proname IN (
              'serialize_fast_conversation_bridge_writes',
              'sync_canonical_fast_conversation_to_legacy',
              'sync_legacy_fast_conversation_to_canonical'
            )
        `);
        expect(bridgeFunctions).toHaveLength(0);
      });
    } finally {
      await db.execute(
        sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`),
      );
    }
  });
});
