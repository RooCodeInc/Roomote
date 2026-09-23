ALTER TABLE "automation_results" ADD COLUMN "run_when_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "run_when_answers" jsonb;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "run_when_outcome" text;--> statement-breakpoint
ALTER TABLE "custom_automations" ADD COLUMN "run_when" jsonb;