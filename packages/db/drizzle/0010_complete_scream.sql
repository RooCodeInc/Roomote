ALTER TABLE "task_runs" ADD COLUMN "environment_setup_state" text;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "environment_setup_completed_at" timestamp;