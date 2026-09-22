ALTER TABLE "automation_results" ADD COLUMN "judgment" jsonb;--> statement-breakpoint
ALTER TABLE "custom_automations" ADD COLUMN "judgment_spec" jsonb;