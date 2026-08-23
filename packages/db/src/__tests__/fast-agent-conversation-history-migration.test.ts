import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db, sql } from '../server';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/0047_yummy_lady_mastermind.sql', import.meta.url),
);
const repositoryPath = fileURLToPath(
  new URL(
    '../../../cloud-agents/src/server/fast-agent/fast-agent-conversation-repository.ts',
    import.meta.url,
  ),
);

describe('Fast conversation history migration', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  it('backfills canonical history and bridges writes from both release versions', async () => {
    const schemaName = `fast_agent_history_${randomUUID().replaceAll('-', '')}`;
    const originalLegacyId = randomUUID();
    const currentLegacyId = randomUUID();
    const oldIntegrationCallId = randomUUID();
    const statements = migration
      .replaceAll('"public".', '')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
        await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}"`));
        await tx.execute(
          sql.raw('CREATE TABLE "users" ("id" text PRIMARY KEY)'),
        );
        await tx.execute(sql`INSERT INTO "users" ("id") VALUES ('user-1')`);
        await tx.execute(
          sql.raw(`
            CREATE TABLE "slack_quick_answers" (
              "id" uuid PRIMARY KEY,
              "user_id" text NOT NULL REFERENCES "users"("id"),
              "slack_channel" text NOT NULL,
              "slack_thread_ts" text NOT NULL,
              "messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
              "created_at" timestamp NOT NULL DEFAULT now(),
              "updated_at" timestamp NOT NULL DEFAULT now(),
              UNIQUE ("slack_channel", "slack_thread_ts")
            )
          `),
        );
        await tx.execute(
          sql.raw(`
            CREATE TABLE "fast_agent_conversations" (
              "id" uuid PRIMARY KEY,
              "user_id" text NOT NULL REFERENCES "users"("id"),
              "surface" text NOT NULL,
              "workspace_id" text NOT NULL,
              "conversation_id" text NOT NULL,
              "current_reply_channel_id" text NOT NULL,
              "current_reply_thread_id" text,
              "reply_target_verified" boolean NOT NULL DEFAULT true,
              "created_at" timestamp NOT NULL DEFAULT now(),
              "updated_at" timestamp NOT NULL DEFAULT now(),
              UNIQUE ("surface", "workspace_id", "conversation_id")
            )
          `),
        );
        await tx.execute(
          sql.raw(`
            CREATE TABLE "fast_agent_conversation_aliases" (
              "legacy_conversation_id" uuid PRIMARY KEY
                REFERENCES "slack_quick_answers"("id") ON DELETE CASCADE,
              "conversation_id" uuid NOT NULL
                REFERENCES "fast_agent_conversations"("id") ON DELETE CASCADE,
              "created_at" timestamp NOT NULL DEFAULT now(),
              "updated_at" timestamp NOT NULL DEFAULT now()
            )
          `),
        );
        await tx.execute(
          sql.raw(`
            CREATE TABLE "slack_fast_integration_calls" (
              "id" uuid PRIMARY KEY,
              "slack_quick_answer_id" uuid NOT NULL
                REFERENCES "slack_quick_answers"("id") ON DELETE CASCADE,
              "created_at" timestamp NOT NULL DEFAULT now()
            )
          `),
        );
        await tx.execute(sql`
          INSERT INTO "slack_quick_answers" (
            "id", "user_id", "slack_channel", "slack_thread_ts", "messages",
            "created_at", "updated_at"
          ) VALUES
            (
              ${originalLegacyId}, 'user-1', 'discord:guild-1:old-parent',
              'thread-1', '[{"role":"user","content":"old branch"}]'::jsonb,
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
            ),
            (
              ${currentLegacyId}, 'user-1', 'discord:guild-1:new-parent',
              'thread-1', '[{"role":"assistant","content":"current history"}]'::jsonb,
              '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
            )
        `);
        await tx.execute(sql`
          INSERT INTO "fast_agent_conversations" (
            "id", "user_id", "surface", "workspace_id", "conversation_id",
            "current_reply_channel_id", "current_reply_thread_id",
            "reply_target_verified", "created_at", "updated_at"
          ) VALUES (
            ${currentLegacyId}, 'user-1', 'discord', 'guild-1', 'thread-1',
            'new-parent', NULL, false,
            '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
          )
        `);
        await tx.execute(sql`
          INSERT INTO "fast_agent_conversation_aliases" (
            "legacy_conversation_id", "conversation_id", "created_at"
          ) VALUES
            (${originalLegacyId}, ${currentLegacyId}, '2026-01-01T00:00:00Z'),
            (${currentLegacyId}, ${currentLegacyId}, '2026-01-02T00:00:00Z')
        `);
        await tx.execute(sql`
          INSERT INTO "slack_fast_integration_calls" (
            "id", "slack_quick_answer_id"
          ) VALUES (${oldIntegrationCallId}, ${originalLegacyId})
        `);

        for (const statement of statements) {
          await tx.execute(sql.raw(statement));
        }

        const [backfilled] = await tx.execute<{
          compatibility_messages: unknown[];
          legacy_conversation_ids: string[];
        }>(sql`
          SELECT "compatibility_messages", "legacy_conversation_ids"
          FROM "fast_agent_conversations"
          WHERE "id" = ${currentLegacyId}
        `);
        expect(backfilled).toEqual({
          compatibility_messages: [
            { role: 'assistant', content: 'current history' },
          ],
          legacy_conversation_ids: expect.arrayContaining([
            originalLegacyId,
            currentLegacyId,
          ]),
        });

        const [integrationCall] = await tx.execute<{
          fast_agent_conversation_id: string;
        }>(sql`
          SELECT "fast_agent_conversation_id"
          FROM "slack_fast_integration_calls"
          WHERE "id" = ${oldIntegrationCallId}
        `);
        expect(integrationCall?.fast_agent_conversation_id).toBe(
          currentLegacyId,
        );

        await tx.execute(sql`
          UPDATE "slack_quick_answers"
          SET "messages" = "messages" ||
            '[{"role":"user","content":"written by N-1"}]'::jsonb
          WHERE "id" = ${originalLegacyId}
        `);
        const [afterLegacyWrite] = await tx.execute<{
          compatibility_messages: unknown[];
          current_reply_channel_id: string;
        }>(sql`
          SELECT "compatibility_messages", "current_reply_channel_id"
          FROM "fast_agent_conversations"
          WHERE "id" = ${currentLegacyId}
        `);
        expect(afterLegacyWrite?.compatibility_messages).toContainEqual({
          role: 'user',
          content: 'written by N-1',
        });
        expect(afterLegacyWrite?.current_reply_channel_id).toBe('new-parent');

        await tx.execute(sql`
          UPDATE "fast_agent_conversations"
          SET "compatibility_messages" = "compatibility_messages" ||
            '[{"role":"assistant","content":"written by N"}]'::jsonb
          WHERE "id" = ${currentLegacyId}
        `);
        const mirroredLegacyRows = await tx.execute<{ messages: unknown[] }>(
          sql`
            SELECT "messages"
            FROM "slack_quick_answers"
            WHERE "id" IN (${originalLegacyId}, ${currentLegacyId})
          `,
        );
        expect(mirroredLegacyRows).toHaveLength(2);
        for (const row of mirroredLegacyRows) {
          expect(row.messages).toContainEqual({
            role: 'assistant',
            content: 'written by N',
          });
        }

        const nMinusOneId = randomUUID();
        await tx.execute(sql`
          INSERT INTO "slack_quick_answers" (
            "id", "user_id", "slack_channel", "slack_thread_ts", "messages"
          ) VALUES (
            ${nMinusOneId}, 'user-1', 'T2:C2', '200.1',
            '[{"role":"user","content":"created during rollout"}]'::jsonb
          )
        `);
        const [createdFromLegacy] = await tx.execute<{
          compatibility_messages: unknown[];
        }>(sql`
          SELECT "compatibility_messages"
          FROM "fast_agent_conversations"
          WHERE "surface" = 'slack'
            AND "workspace_id" = 'T2'
            AND "conversation_id" = '200.1'
        `);
        expect(createdFromLegacy?.compatibility_messages).toEqual([
          { role: 'user', content: 'created during rollout' },
        ]);

        const canonicalOnlyId = randomUUID();
        await tx.execute(sql`
          INSERT INTO "fast_agent_conversations" (
            "id", "user_id", "surface", "workspace_id", "conversation_id",
            "current_reply_channel_id", "current_reply_thread_id",
            "compatibility_messages"
          ) VALUES (
            ${canonicalOnlyId}, 'user-1', 'slack', 'T3', '300.1', 'C3', '300.1',
            '[{"role":"assistant","content":"created by N"}]'::jsonb
          )
        `);
        const [createdForRollback] = await tx.execute<{ messages: unknown[] }>(
          sql`
            SELECT "messages"
            FROM "slack_quick_answers"
            WHERE "slack_channel" = 'T3:C3'
              AND "slack_thread_ts" = '300.1'
          `,
        );
        expect(createdForRollback?.messages).toEqual([
          { role: 'assistant', content: 'created by N' },
        ]);
      });
    } finally {
      await db.execute(
        sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`),
      );
    }
  });

  it('keeps legacy tables while removing application repository access', () => {
    const repository = readFileSync(repositoryPath, 'utf8');

    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(repository).not.toMatch(
      /slackQuickAnswers|fastAgentConversationAliases/,
    );
  });
});
