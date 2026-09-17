CREATE TABLE "release_announcement_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"previous_version" text NOT NULL,
	"installed_version" text NOT NULL,
	"provider" text NOT NULL,
	"destination_key" text NOT NULL,
	"channel_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"provider_message_id" text,
	"last_error" text,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "release_announcement_deliveries_status_check" CHECK ("release_announcement_deliveries"."status" in ('pending', 'delivered')),
	CONSTRAINT "release_announcement_deliveries_provider_check" CHECK ("release_announcement_deliveries"."provider" in ('slack', 'teams', 'telegram', 'discord'))
);
--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "installed_release_version" text;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "installed_release_recorded_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "release_announcement_deliveries_version_destination_unique" ON "release_announcement_deliveries" USING btree ("installed_version","destination_key");--> statement-breakpoint
CREATE INDEX "release_announcement_deliveries_due_idx" ON "release_announcement_deliveries" USING btree ("status","next_attempt_at","lease_expires_at");
