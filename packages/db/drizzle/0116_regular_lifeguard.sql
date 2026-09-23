ALTER TABLE "automation_results" ADD COLUMN "launch_criteria_snapshot" text;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "launch_criteria_answers" jsonb;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "launch_criteria_outcome" text;--> statement-breakpoint
ALTER TABLE "custom_automations" ADD COLUMN "launch_criteria" text;