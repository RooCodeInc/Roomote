ALTER TABLE "automation_results" ADD COLUMN "launch_criteria_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "launch_criteria_answers" jsonb;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "launch_criteria_outcome" jsonb;--> statement-breakpoint
ALTER TABLE "custom_automations" ADD COLUMN "launch_criteria" text;--> statement-breakpoint
ALTER TABLE "custom_automations" ADD COLUMN "run_when" jsonb;