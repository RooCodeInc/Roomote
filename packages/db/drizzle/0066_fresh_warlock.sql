ALTER TABLE "sessions" ADD COLUMN "title_edited_by_user_at" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "llm_title_checkpoint" integer DEFAULT 0 NOT NULL;