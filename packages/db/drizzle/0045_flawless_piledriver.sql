CREATE TABLE "fast_agent_conversation_aliases" (
	"legacy_conversation_id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fast_agent_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"surface" text NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"current_reply_channel_id" text NOT NULL,
	"current_reply_thread_id" text,
	"reply_target_verified" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fast_agent_conversation_aliases" ADD CONSTRAINT "fast_agent_conversation_aliases_legacy_conversation_id_slack_quick_answers_id_fk" FOREIGN KEY ("legacy_conversation_id") REFERENCES "public"."slack_quick_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fast_agent_conversation_aliases" ADD CONSTRAINT "fast_agent_conversation_aliases_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD CONSTRAINT "fast_agent_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fast_agent_conversation_aliases_conversation_idx" ON "fast_agent_conversation_aliases" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fast_agent_conversations_identity_unique" ON "fast_agent_conversations" USING btree ("surface","workspace_id","conversation_id");--> statement-breakpoint
CREATE INDEX "fast_agent_conversations_user_idx" ON "fast_agent_conversations" USING btree ("user_id");--> statement-breakpoint
WITH parsed_legacy AS (
	SELECT
		legacy.*,
		CASE WHEN legacy."slack_channel" LIKE 'discord:%' THEN 'discord' ELSE 'slack' END AS "surface",
		CASE
			WHEN legacy."slack_channel" LIKE 'discord:%' THEN split_part(legacy."slack_channel", ':', 2)
			ELSE split_part(legacy."slack_channel", ':', 1)
		END AS "workspace_id",
		legacy."slack_thread_ts" AS "conversation_id"
	FROM "slack_quick_answers" AS legacy
), ranked_legacy AS (
	SELECT
		parsed_legacy.*,
		row_number() OVER (
			PARTITION BY "surface", "workspace_id", "conversation_id"
			ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
		) AS "identity_rank"
	FROM parsed_legacy
)
INSERT INTO "fast_agent_conversations" (
	"id",
	"user_id",
	"surface",
	"workspace_id",
	"conversation_id",
	"current_reply_channel_id",
	"current_reply_thread_id",
	"reply_target_verified",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"user_id",
	"surface",
	"workspace_id",
	"conversation_id",
	CASE
		WHEN "slack_channel" LIKE 'discord:%' THEN regexp_replace("slack_channel", '^discord:[^:]+:', '')
		ELSE regexp_replace("slack_channel", '^[^:]+:', '')
	END,
	CASE WHEN "slack_channel" LIKE 'discord:%' THEN NULL ELSE "slack_thread_ts" END,
	"slack_channel" NOT LIKE 'discord:%',
	"created_at",
	"updated_at"
FROM ranked_legacy
WHERE "identity_rank" = 1;--> statement-breakpoint
WITH parsed_legacy AS (
	SELECT
		legacy."id",
		CASE WHEN legacy."slack_channel" LIKE 'discord:%' THEN 'discord' ELSE 'slack' END AS "surface",
		CASE
			WHEN legacy."slack_channel" LIKE 'discord:%' THEN split_part(legacy."slack_channel", ':', 2)
			ELSE split_part(legacy."slack_channel", ':', 1)
		END AS "workspace_id",
		legacy."slack_thread_ts" AS "conversation_id"
	FROM "slack_quick_answers" AS legacy
)
INSERT INTO "fast_agent_conversation_aliases" (
	"legacy_conversation_id",
	"conversation_id"
)
SELECT
	legacy."id",
	conversation."id"
FROM parsed_legacy AS legacy
INNER JOIN "fast_agent_conversations" AS conversation
	ON conversation."surface" = legacy."surface"
	AND conversation."workspace_id" = legacy."workspace_id"
	AND conversation."conversation_id" = legacy."conversation_id";
