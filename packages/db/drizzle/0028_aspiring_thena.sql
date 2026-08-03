CREATE TABLE "license_usage_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"observed_at" timestamp NOT NULL,
	"active_users" integer NOT NULL,
	"delivered_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "license_cloud_state" jsonb;--> statement-breakpoint
CREATE INDEX "license_usage_observations_pending_idx" ON "license_usage_observations" USING btree ("delivered_at","observed_at");