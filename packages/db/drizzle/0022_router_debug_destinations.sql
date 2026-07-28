ALTER TABLE "deployment_settings" ADD COLUMN "router_debug_provider" text;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "router_debug_channel_id" text;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "router_debug_disabled" boolean DEFAULT false NOT NULL;