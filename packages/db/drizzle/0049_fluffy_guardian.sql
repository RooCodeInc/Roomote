CREATE TABLE "automation_run_children" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_run_id" uuid NOT NULL,
	"logical_launch_key" text NOT NULL,
	"task_id" text NOT NULL,
	"terminal_outcome" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_run_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_run_id" uuid NOT NULL,
	"logical_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'executing' NOT NULL,
	"attempt_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_signature" text,
	"integration_id" text,
	"tool_name" text,
	"external_id" text,
	"metadata" jsonb,
	"result_preview" text,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_key" text NOT NULL,
	"automation_key" text,
	"custom_automation_id" uuid,
	"trigger_kind" text NOT NULL,
	"occurrence_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"prompt_snapshot" text NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"policy_version" integer NOT NULL,
	"created_by_user_id" text,
	"destination" jsonb,
	"delivery_message_id" text,
	"delivery_thread_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"last_error" text,
	"orchestration_session_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" real,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_source_check" CHECK (("automation_runs"."automation_key" IS NOT NULL)::int + ("automation_runs"."custom_automation_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "execution_route" text DEFAULT 'legacy_task' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_run_children" ADD CONSTRAINT "automation_run_children_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_children" ADD CONSTRAINT "automation_run_children_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_effects" ADD CONSTRAINT "automation_run_effects_automation_run_id_automation_runs_id_fk" FOREIGN KEY ("automation_run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_key_automations_key_fk" FOREIGN KEY ("automation_key") REFERENCES "public"."automations"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_children_launch_key_unique_idx" ON "automation_run_children" USING btree ("automation_run_id","logical_launch_key");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_children_task_unique_idx" ON "automation_run_children" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_run_effects_logical_key_unique_idx" ON "automation_run_effects" USING btree ("automation_run_id","logical_key");--> statement-breakpoint
CREATE INDEX "automation_run_effects_status_idx" ON "automation_run_effects" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_occurrence_unique_idx" ON "automation_runs" USING btree ("source_key","occurrence_key");--> statement-breakpoint
CREATE INDEX "automation_runs_status_lease_idx" ON "automation_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_key_idx" ON "automation_runs" USING btree ("automation_key","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_custom_automation_id_idx" ON "automation_runs" USING btree ("custom_automation_id","created_at");
--> statement-breakpoint
UPDATE "automations"
SET "execution_route" = 'fast', "updated_at" = now()
WHERE "key" IN ('announcer', 'sentry_triage');
