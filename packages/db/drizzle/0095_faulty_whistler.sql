CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"environment" text NOT NULL,
	"bundle_id" text NOT NULL,
	"app_version" text,
	"device_name" text,
	"categories" jsonb DEFAULT '{"user_input":true,"capability_offer":true,"task_settled":true,"reply":true}'::jsonb NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"disabled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_platform_token_unique" UNIQUE("platform","token"),
	CONSTRAINT "user_devices_platform_check" CHECK ("user_devices"."platform" in ('ios')),
	CONSTRAINT "user_devices_environment_check" CHECK ("user_devices"."environment" in ('production', 'sandbox'))
);
--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_devices_user_id_idx" ON "user_devices" USING btree ("user_id");