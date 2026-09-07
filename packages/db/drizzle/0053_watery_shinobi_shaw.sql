DROP TRIGGER "serialize_canonical_fast_conversation_bridge_writes" ON "fast_agent_conversations";--> statement-breakpoint
DROP TRIGGER "sync_canonical_fast_conversation_to_legacy" ON "fast_agent_conversations";--> statement-breakpoint
DROP TRIGGER "serialize_legacy_fast_conversation_bridge_writes" ON "slack_quick_answers";--> statement-breakpoint
DROP TRIGGER "sync_legacy_fast_conversation_to_canonical" ON "slack_quick_answers";--> statement-breakpoint
DROP FUNCTION "serialize_fast_conversation_bridge_writes"();--> statement-breakpoint
DROP FUNCTION "sync_canonical_fast_conversation_to_legacy"();--> statement-breakpoint
DROP FUNCTION "sync_legacy_fast_conversation_to_canonical"();--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" DROP CONSTRAINT "slack_conversation_messages_slack_quick_answer_id_slack_quick_answers_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_fast_integration_calls" DROP CONSTRAINT "slack_fast_integration_calls_slack_quick_answer_id_slack_quick_answers_id_fk";
--> statement-breakpoint
DROP INDEX "slack_fast_integration_calls_session_idx";--> statement-breakpoint
ALTER TABLE "slack_fast_integration_calls" ALTER COLUMN "fast_agent_conversation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" DROP COLUMN "slack_quick_answer_id";--> statement-breakpoint
ALTER TABLE "slack_fast_integration_calls" DROP COLUMN "slack_quick_answer_id";--> statement-breakpoint
ALTER TABLE "fast_agent_conversation_aliases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "slack_quick_answers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "fast_agent_conversation_aliases";--> statement-breakpoint
DROP TABLE "slack_quick_answers";
