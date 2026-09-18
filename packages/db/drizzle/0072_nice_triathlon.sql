ALTER TABLE "fast_agent_parent_events" ADD COLUMN "retry_at" timestamp;--> statement-breakpoint
ALTER TABLE "fast_agent_parent_events" ADD COLUMN "inference_retries" integer DEFAULT 0 NOT NULL;