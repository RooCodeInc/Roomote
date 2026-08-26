ALTER TABLE "fast_agent_conversations" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "reasoning_effort" text;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "title_edited_by_user_at" timestamp;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "llm_title_checkpoint" integer DEFAULT 0 NOT NULL;