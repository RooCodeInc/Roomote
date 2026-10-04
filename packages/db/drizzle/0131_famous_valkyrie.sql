CREATE TABLE "session_done_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"judgment_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_done_webhook_deliveries_status_check" CHECK ("session_done_webhook_deliveries"."status" in ('pending', 'delivered', 'failed', 'skipped')),
	CONSTRAINT "session_done_webhook_deliveries_attempts_check" CHECK ("session_done_webhook_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "session_done_webhook_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "session_done_webhook_url" text;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN "session_done_webhook_secret" text;--> statement-breakpoint
ALTER TABLE "session_done_webhook_deliveries" ADD CONSTRAINT "session_done_webhook_deliveries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_done_webhook_deliveries" ADD CONSTRAINT "session_done_webhook_deliveries_judgment_id_session_status_judgments_id_fk" FOREIGN KEY ("judgment_id") REFERENCES "public"."session_status_judgments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_done_webhook_deliveries_judgment_unique" ON "session_done_webhook_deliveries" USING btree ("judgment_id");--> statement-breakpoint
CREATE INDEX "session_done_webhook_deliveries_due_idx" ON "session_done_webhook_deliveries" USING btree ("status","next_attempt_at","lease_expires_at");