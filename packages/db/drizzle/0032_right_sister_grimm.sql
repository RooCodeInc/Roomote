CREATE TABLE "task_workspace_transition_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transition_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "task_workspace_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"source_run_id" integer NOT NULL,
	"target_run_id" integer,
	"requested_by_user_id" text,
	"target_environment_id" uuid NOT NULL,
	"target_environment_config_version_id" uuid NOT NULL,
	"resolved_workspace_spec" jsonb NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"git_manifest" jsonb,
	"handoff" jsonb,
	"blocked_reason" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "harness_session_id" text;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "environment_config_version_id" uuid;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "resolved_workspace_spec" jsonb;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "termination_reason" text;--> statement-breakpoint
ALTER TABLE "task_workspace_transition_inputs" ADD CONSTRAINT "task_workspace_transition_inputs_transition_id_task_workspace_transitions_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."task_workspace_transitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_transitions" ADD CONSTRAINT "task_workspace_transitions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_transitions" ADD CONSTRAINT "task_workspace_transitions_source_run_id_task_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_transitions" ADD CONSTRAINT "task_workspace_transitions_target_run_id_task_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_transitions" ADD CONSTRAINT "task_workspace_transitions_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_transitions" ADD CONSTRAINT "task_workspace_transitions_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workspace_transitions" ADD CONSTRAINT "task_workspace_transitions_target_environment_config_version_id_environment_config_versions_id_fk" FOREIGN KEY ("target_environment_config_version_id") REFERENCES "public"."environment_config_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_workspace_transition_inputs_transition_id_idx" ON "task_workspace_transition_inputs" USING btree ("transition_id","created_at");--> statement-breakpoint
CREATE INDEX "task_workspace_transitions_task_id_created_at_idx" ON "task_workspace_transitions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_workspace_transitions_source_run_id_idx" ON "task_workspace_transitions" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "task_workspace_transitions_target_run_id_idx" ON "task_workspace_transitions" USING btree ("target_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_workspace_transitions_one_active_per_task_idx" ON "task_workspace_transitions" USING btree ("task_id") WHERE "task_workspace_transitions"."status" NOT IN ('succeeded', 'failed', 'canceled');--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_environment_config_version_id_environment_config_versions_id_fk" FOREIGN KEY ("environment_config_version_id") REFERENCES "public"."environment_config_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_runs_environment_config_version_id_idx" ON "task_runs" USING btree ("environment_config_version_id");