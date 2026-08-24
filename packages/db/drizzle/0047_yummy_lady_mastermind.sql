ALTER TABLE "slack_fast_integration_calls" ALTER COLUMN "slack_quick_answer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "compatibility_messages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "legacy_conversation_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_fast_integration_calls" ADD COLUMN "fast_agent_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "slack_fast_integration_calls" ADD CONSTRAINT "slack_fast_integration_calls_fast_agent_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("fast_agent_conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fast_agent_conversations_legacy_ids_idx" ON "fast_agent_conversations" USING gin ("legacy_conversation_ids");--> statement-breakpoint
CREATE INDEX "slack_fast_integration_calls_conversation_idx" ON "slack_fast_integration_calls" USING btree ("fast_agent_conversation_id","created_at");--> statement-breakpoint

-- Phase-one N-1 bridge. Current application code reads and writes only
-- fast_agent_conversations. These triggers keep the previous release safe
-- during the migration-to-rollout window and after a one-release rollback.
CREATE FUNCTION "serialize_fast_conversation_bridge_writes"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(
		hashtextextended('fast-agent-conversation-history-bridge', 0)
	);
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "sync_legacy_fast_conversation_to_canonical"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	canonical_id uuid;
	surface_name text;
	parsed_workspace_id text;
	reply_channel_id text;
	reply_thread_id text;
BEGIN
	IF pg_trigger_depth() > 1 THEN
		RETURN NEW;
	END IF;

	IF NEW."slack_channel" LIKE 'discord:%' THEN
		surface_name := 'discord';
		parsed_workspace_id := split_part(NEW."slack_channel", ':', 2);
		reply_channel_id := regexp_replace(NEW."slack_channel", '^discord:[^:]+:', '');
		reply_thread_id := NULL;
	ELSE
		surface_name := 'slack';
		parsed_workspace_id := split_part(NEW."slack_channel", ':', 1);
		reply_channel_id := regexp_replace(NEW."slack_channel", '^[^:]+:', '');
		reply_thread_id := NEW."slack_thread_ts";
	END IF;

	INSERT INTO "fast_agent_conversations" AS canonical (
		"id",
		"user_id",
		"surface",
		"workspace_id",
		"conversation_id",
		"current_reply_channel_id",
		"current_reply_thread_id",
		"reply_target_verified",
		"compatibility_messages",
		"legacy_conversation_ids",
		"created_at",
		"updated_at"
	) VALUES (
		NEW."id",
		NEW."user_id",
		surface_name,
		parsed_workspace_id,
		NEW."slack_thread_ts",
		reply_channel_id,
		reply_thread_id,
		surface_name = 'slack',
		NEW."messages",
		ARRAY[NEW."id"],
		NEW."created_at",
		NEW."updated_at"
	)
	ON CONFLICT ("surface", "workspace_id", "conversation_id") DO UPDATE
	SET
		"current_reply_channel_id" = CASE
			WHEN TG_OP = 'INSERT' THEN EXCLUDED."current_reply_channel_id"
			ELSE canonical."current_reply_channel_id"
		END,
		"current_reply_thread_id" = CASE
			WHEN TG_OP = 'INSERT' THEN EXCLUDED."current_reply_thread_id"
			ELSE canonical."current_reply_thread_id"
		END,
		"reply_target_verified" = CASE
			WHEN TG_OP = 'INSERT' THEN EXCLUDED."reply_target_verified"
			ELSE canonical."reply_target_verified"
		END,
		"compatibility_messages" = EXCLUDED."compatibility_messages",
		"legacy_conversation_ids" = CASE
			WHEN EXCLUDED."id" = ANY(canonical."legacy_conversation_ids")
				THEN canonical."legacy_conversation_ids"
			ELSE array_append(canonical."legacy_conversation_ids", EXCLUDED."id")
		END,
		"updated_at" = GREATEST(canonical."updated_at", EXCLUDED."updated_at")
	RETURNING "id" INTO canonical_id;

	INSERT INTO "fast_agent_conversation_aliases" (
		"legacy_conversation_id",
		"conversation_id"
	) VALUES (
		NEW."id",
		canonical_id
	)
	ON CONFLICT ("legacy_conversation_id") DO NOTHING;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "sync_canonical_fast_conversation_to_legacy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	legacy_channel text;
	legacy_id uuid;
BEGIN
	IF pg_trigger_depth() > 1 THEN
		RETURN NEW;
	END IF;

	legacy_channel := CASE
		WHEN NEW."surface" = 'discord'
			THEN 'discord:' || NEW."workspace_id" || ':' || NEW."current_reply_channel_id"
		ELSE NEW."workspace_id" || ':' || NEW."current_reply_channel_id"
	END;

	SELECT "id"
	INTO legacy_id
	FROM "slack_quick_answers"
	WHERE "slack_channel" = legacy_channel
		AND "slack_thread_ts" = NEW."conversation_id"
	LIMIT 1;

	IF legacy_id IS NULL THEN
		legacy_id := CASE
			WHEN EXISTS (
				SELECT 1 FROM "slack_quick_answers" WHERE "id" = NEW."id"
			) THEN gen_random_uuid()
			ELSE NEW."id"
		END;

		INSERT INTO "slack_quick_answers" (
			"id",
			"user_id",
			"slack_channel",
			"slack_thread_ts",
			"messages",
			"created_at",
			"updated_at"
		) VALUES (
			legacy_id,
			NEW."user_id",
			legacy_channel,
			NEW."conversation_id",
			NEW."compatibility_messages",
			NEW."created_at",
			NEW."updated_at"
		);
	END IF;

	INSERT INTO "fast_agent_conversation_aliases" (
		"legacy_conversation_id",
		"conversation_id"
	) VALUES (
		legacy_id,
		NEW."id"
	)
	ON CONFLICT ("legacy_conversation_id") DO NOTHING;

	IF NOT legacy_id = ANY(NEW."legacy_conversation_ids") THEN
		UPDATE "fast_agent_conversations"
		SET "legacy_conversation_ids" = array_append(
			"legacy_conversation_ids",
			legacy_id
		)
		WHERE "id" = NEW."id";
	END IF;

	UPDATE "slack_quick_answers" AS legacy
	SET
		"messages" = NEW."compatibility_messages",
		"updated_at" = NEW."updated_at"
	FROM "fast_agent_conversation_aliases" AS alias
	WHERE alias."conversation_id" = NEW."id"
		AND alias."legacy_conversation_id" = legacy."id"
		AND legacy."messages" IS DISTINCT FROM NEW."compatibility_messages";

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "serialize_legacy_fast_conversation_bridge_writes"
BEFORE INSERT OR UPDATE ON "slack_quick_answers"
FOR EACH STATEMENT
EXECUTE FUNCTION "serialize_fast_conversation_bridge_writes"();--> statement-breakpoint

CREATE TRIGGER "serialize_canonical_fast_conversation_bridge_writes"
BEFORE INSERT OR UPDATE ON "fast_agent_conversations"
FOR EACH STATEMENT
EXECUTE FUNCTION "serialize_fast_conversation_bridge_writes"();--> statement-breakpoint

CREATE TRIGGER "sync_legacy_fast_conversation_to_canonical"
AFTER INSERT OR UPDATE ON "slack_quick_answers"
FOR EACH ROW
EXECUTE FUNCTION "sync_legacy_fast_conversation_to_canonical"();--> statement-breakpoint

CREATE TRIGGER "sync_canonical_fast_conversation_to_legacy"
AFTER INSERT OR UPDATE ON "fast_agent_conversations"
FOR EACH ROW
EXECUTE FUNCTION "sync_canonical_fast_conversation_to_legacy"();--> statement-breakpoint

UPDATE "fast_agent_conversations" AS canonical
SET
	"compatibility_messages" = COALESCE(
		(
			SELECT legacy."messages"
			FROM "slack_quick_answers" AS legacy
			WHERE legacy."slack_channel" = CASE
				WHEN canonical."surface" = 'discord'
					THEN 'discord:' || canonical."workspace_id" || ':' || canonical."current_reply_channel_id"
				ELSE canonical."workspace_id" || ':' || canonical."current_reply_channel_id"
			END
				AND legacy."slack_thread_ts" = canonical."conversation_id"
			LIMIT 1
		),
		(
			SELECT legacy."messages"
			FROM "fast_agent_conversation_aliases" AS alias
			INNER JOIN "slack_quick_answers" AS legacy
				ON legacy."id" = alias."legacy_conversation_id"
			WHERE alias."conversation_id" = canonical."id"
			ORDER BY alias."created_at", alias."legacy_conversation_id"
			LIMIT 1
		),
		'[]'::jsonb
	),
	"legacy_conversation_ids" = ARRAY(
		SELECT alias."legacy_conversation_id"
		FROM "fast_agent_conversation_aliases" AS alias
		WHERE alias."conversation_id" = canonical."id"
		ORDER BY alias."created_at", alias."legacy_conversation_id"
	);--> statement-breakpoint

UPDATE "slack_fast_integration_calls" AS integration_call
SET "fast_agent_conversation_id" = alias."conversation_id"
FROM "fast_agent_conversation_aliases" AS alias
WHERE integration_call."slack_quick_answer_id" = alias."legacy_conversation_id";--> statement-breakpoint

UPDATE "slack_fast_integration_calls" AS integration_call
SET "fast_agent_conversation_id" = canonical."id"
FROM "fast_agent_conversations" AS canonical
WHERE integration_call."fast_agent_conversation_id" IS NULL
	AND integration_call."slack_quick_answer_id" = canonical."id";
