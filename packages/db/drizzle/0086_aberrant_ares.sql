DROP INDEX "fast_agent_messages_conversation_order_idx";--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "open_code_projection_hash" text;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "open_code_projected_through_seq" bigint;--> statement-breakpoint
ALTER TABLE "fast_agent_messages" ADD COLUMN "conversation_seq" bigint;--> statement-breakpoint
ALTER TABLE "fast_agent_messages" ADD COLUMN "observed_at" timestamp;--> statement-breakpoint
WITH ranked AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "conversation_id"
		ORDER BY "created_at", "ts", "turn_seq", "id"
	) AS "conversation_seq"
	FROM "fast_agent_messages"
)
UPDATE "fast_agent_messages" AS messages
SET
	"conversation_seq" = ranked."conversation_seq",
	"observed_at" = to_timestamp(messages."ts" / 1000.0)
FROM ranked
WHERE messages."id" = ranked."id";--> statement-breakpoint
CREATE INDEX "fast_agent_messages_legacy_order_idx" ON "fast_agent_messages" USING btree ("conversation_id","ts","turn_seq");--> statement-breakpoint
CREATE INDEX "fast_agent_messages_conversation_order_idx" ON "fast_agent_messages" USING btree ("conversation_id","conversation_seq");
