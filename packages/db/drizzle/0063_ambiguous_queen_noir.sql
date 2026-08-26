ALTER TABLE "tasks" ADD COLUMN "resolution_status" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "resolution_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_resolution_status_check" CHECK ("tasks"."resolution_status" IS NULL OR "tasks"."resolution_status" in ('awaiting_confirmation', 'acknowledged', 'needs_follow_up'));