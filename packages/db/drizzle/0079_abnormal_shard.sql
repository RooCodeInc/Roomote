CREATE TABLE "automation_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"note_id" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"lease_until" timestamp,
	"lease_token" uuid,
	"launch_claimed_at" timestamp,
	"first_dispatched_at" timestamp,
	"session_id" uuid,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_webhook_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider" varchar(64) DEFAULT 'granola' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_endpoint_id" text,
	"encrypted_signing_secret" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"folder_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by_user_id" uuid,
	"max_runs_per_day" integer DEFAULT 20 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_webhook_deliveries" ADD CONSTRAINT "automation_webhook_deliveries_trigger_id_automation_webhook_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_webhook_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhook_triggers" ADD CONSTRAINT "automation_webhook_triggers_automation_id_custom_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."custom_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhook_triggers" ADD CONSTRAINT "automation_webhook_triggers_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_webhook_deliveries_event_idx" ON "automation_webhook_deliveries" USING btree ("trigger_id","event_id");--> statement-breakpoint
CREATE INDEX "automation_webhook_deliveries_due_idx" ON "automation_webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "automation_webhook_deliveries_daily_idx" ON "automation_webhook_deliveries" USING btree ("trigger_id","first_dispatched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_webhook_triggers_automation_idx" ON "automation_webhook_triggers" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_webhook_triggers_connection_idx" ON "automation_webhook_triggers" USING btree ("connection_id");