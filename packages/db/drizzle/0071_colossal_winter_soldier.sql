ALTER TABLE "fast_agent_conversations" ADD COLUMN "initial_turn" jsonb;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "initial_turn_completed_at" timestamp;