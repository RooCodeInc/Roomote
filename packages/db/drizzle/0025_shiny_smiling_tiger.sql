ALTER TABLE "custom_automations" ADD COLUMN "cron_expression" text;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "time_zone_updated_at" timestamp;