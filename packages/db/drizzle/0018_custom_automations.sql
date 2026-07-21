CREATE TABLE "custom_automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"schedule_mode" text DEFAULT 'off' NOT NULL,
	"environment_id" uuid,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"last_run_at" timestamp,
	"last_succeeded_at" timestamp,
	"last_failed_at" timestamp,
	"last_error" text,
	"last_launched_task_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_automations" ADD CONSTRAINT "custom_automations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_automations" ADD CONSTRAINT "custom_automations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_automations" ADD CONSTRAINT "custom_automations_last_launched_task_id_tasks_id_fk" FOREIGN KEY ("last_launched_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_automations_name_unique_idx" ON "custom_automations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "custom_automations_enabled_idx" ON "custom_automations" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "custom_automations_environment_id_idx" ON "custom_automations" USING btree ("environment_id");
