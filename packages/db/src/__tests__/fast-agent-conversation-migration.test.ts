import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { db, sql } from '../server';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/0045_flawless_piledriver.sql', import.meta.url),
);

describe('Fast conversation migration', () => {
  const migration = readFileSync(migrationPath, 'utf8');

  it('backfills Slack and Discord identity, destination, and every legacy alias', async () => {
    const schemaName = `fast_agent_migration_${randomUUID().replaceAll('-', '')}`;
    const slackId = randomUUID();
    const discordId = randomUUID();
    const movedDiscordId = randomUUID();
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
        await tx.execute(sql`
          INSERT INTO "slack_quick_answers" (
            "id", "user_id", "slack_channel", "slack_thread_ts", "messages",
            "created_at", "updated_at"
          ) VALUES
            (
              ${slackId},
              'user-1',
              'T123:C123',
              '100.1',
              '[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"}]'::jsonb,
              '2026-01-01T00:00:00Z',
              '2026-01-01T00:00:00Z'
            ),
            (
              ${discordId},
              'user-1',
              'discord:guild-1:channel-1',
              'thread-1',
              '[{"role":"user","content":"discord hello"}]'::jsonb,
              '2026-01-01T00:00:00Z',
              '2026-01-01T00:00:00Z'
            ),
            (
              ${movedDiscordId},
              'user-1',
              'discord:guild-1:channel-2',
              'thread-1',
              '[{"role":"assistant","content":"discord moved"}]'::jsonb,
              '2026-01-02T00:00:00Z',
              '2026-01-02T00:00:00Z'
            )
        `);

        for (const statement of statements) {
          await tx.execute(sql.raw(statement));
        }

        const conversations = await tx.execute<{
          id: string;
          surface: string;
          workspace_id: string;
          conversation_id: string;
          current_reply_channel_id: string;
          current_reply_thread_id: string | null;
          reply_target_verified: boolean;
        }>(sql`
          SELECT
            "id", "surface", "workspace_id", "conversation_id",
            "current_reply_channel_id", "current_reply_thread_id",
            "reply_target_verified"
          FROM "fast_agent_conversations"
          ORDER BY "surface" DESC
        `);
        expect(conversations).toEqual([
          {
            id: slackId,
            surface: 'slack',
            workspace_id: 'T123',
            conversation_id: '100.1',
            current_reply_channel_id: 'C123',
            current_reply_thread_id: '100.1',
            reply_target_verified: true,
          },
          {
            id: movedDiscordId,
            surface: 'discord',
            workspace_id: 'guild-1',
            conversation_id: 'thread-1',
            current_reply_channel_id: 'channel-2',
            current_reply_thread_id: null,
            reply_target_verified: false,
          },
        ]);

        const aliases = await tx.execute<{
          legacy_conversation_id: string;
          conversation_id: string;
        }>(sql`
          SELECT
            "legacy_conversation_id", "conversation_id"
          FROM "fast_agent_conversation_aliases"
          WHERE "legacy_conversation_id" IN (${discordId}, ${movedDiscordId})
          ORDER BY "legacy_conversation_id"
        `);
        expect(aliases).toHaveLength(2);
        expect(aliases.map(({ conversation_id }) => conversation_id)).toEqual([
          movedDiscordId,
          movedDiscordId,
        ]);
        const tables = await tx.execute<{ table_name: string }>(sql`
          SELECT "table_name"
          FROM information_schema.tables
          WHERE table_schema = ${schemaName}
            AND table_name = 'fast_agent_messages'
        `);
        expect(tables).toEqual([]);
      });
    } finally {
      await db.execute(
        sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`),
      );
    }
  });

  it('keeps the N-1 table and columns intact', () => {
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN).*slack_/i);
    expect(migration).not.toMatch(/ALTER TABLE "slack_quick_answers"/i);
  });
});
