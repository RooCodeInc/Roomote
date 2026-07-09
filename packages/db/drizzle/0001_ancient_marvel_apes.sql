CREATE TABLE "task_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" integer NOT NULL,
	"task_id" text NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"message" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"task_id" text NOT NULL,
	"kind" text DEFAULT 'fresh' NOT NULL,
	"source_run_id" integer,
	"acting_user_id" text,
	"payload_kind" text NOT NULL,
	"harness" text DEFAULT 'opencode-server' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_phase" text,
	"payload" jsonb NOT NULL,
	"prompt" text,
	"log" text,
	"artifacts" jsonb,
	"result" jsonb,
	"error" text,
	"machine_id" text,
	"sandbox_cmd_id" text,
	"machine_domain" text,
	"machine_domains" jsonb,
	"initial_paths" jsonb,
	"primary_port_name" text,
	"sandbox_server_url" text,
	"proxy_ports" jsonb,
	"worker_release_tag" text,
	"worker_version" text,
	"worker_commit" text,
	"vendor" text,
	"port" integer,
	"configured_vcpus" integer,
	"configured_cpu_cores" real,
	"configured_memory_mib" integer,
	"snapshot_id" text,
	"snapshot_requested_at" timestamp,
	"snapshot_created_at" timestamp,
	"snapshot_failed_at" timestamp,
	"keepalive_ms" integer,
	"sleep_at" timestamp,
	"sleep_requested_at" timestamp,
	"worker_heartbeat_at" timestamp,
	"source_snapshot_id" text,
	"base_shas" jsonb,
	"auth_bypass_value" text,
	"auth_bypass_header_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"dequeued_at" timestamp,
	"provision_started_at" timestamp,
	"provision_ready_at" timestamp,
	"started_at" timestamp,
	"setup_completed_at" timestamp,
	"harness_started_at" timestamp,
	"runtime_task_started_at" timestamp,
	"first_assistant_output_at" timestamp,
	"completed_at" timestamp,
	"canceled_at" timestamp,
	"launch_mode" text
);
--> statement-breakpoint
ALTER TABLE "cloud_job_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_jobs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deleted_tasks" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "eval_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "cloud_job_events" CASCADE;--> statement-breakpoint
DROP TABLE "cloud_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "deleted_tasks" CASCADE;--> statement-breakpoint
DROP TABLE "eval_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_oidc_targets" DROP CONSTRAINT "sandbox_oidc_targets_owner_required";--> statement-breakpoint
ALTER TABLE "compute_provider_usage" DROP CONSTRAINT "compute_provider_usage_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "compute_provider_usage" DROP CONSTRAINT "compute_provider_usage_cloud_job_id_cloud_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "compute_provider_usage_samples" DROP CONSTRAINT "compute_provider_usage_samples_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "compute_provider_usage_samples" DROP CONSTRAINT "compute_provider_usage_samples_cloud_job_id_cloud_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "sandbox_oidc_targets" DROP CONSTRAINT "sandbox_oidc_targets_cloud_job_id_cloud_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" DROP CONSTRAINT "slack_conversation_messages_cloud_job_id_cloud_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "task_artifacts" DROP CONSTRAINT "task_artifacts_cloud_job_id_cloud_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" DROP CONSTRAINT "task_inference_usage_events_cloud_job_id_cloud_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" DROP CONSTRAINT "task_inference_usage_events_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "task_messages" DROP CONSTRAINT "task_messages_cloud_job_id_cloud_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "task_platform_issue_reports" DROP CONSTRAINT "task_platform_issue_reports_cloud_job_id_cloud_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_attributed_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_effective_author_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_effective_pr_owner_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "compute_provider_usage_user_id_idx";--> statement-breakpoint
DROP INDEX "compute_provider_usage_cloud_job_id_idx";--> statement-breakpoint
DROP INDEX "compute_provider_usage_samples_user_id_idx";--> statement-breakpoint
DROP INDEX "compute_provider_usage_samples_cloud_job_id_idx";--> statement-breakpoint
DROP INDEX "sandbox_oidc_targets_cloud_job_id_idx";--> statement-breakpoint
DROP INDEX "slack_conversation_messages_cloud_job_id_idx";--> statement-breakpoint
DROP INDEX "task_artifacts_cloud_job_id_idx";--> statement-breakpoint
DROP INDEX "task_inference_usage_events_cloud_job_id_idx";--> statement-breakpoint
DROP INDEX "task_inference_usage_events_user_id_idx";--> statement-breakpoint
DROP INDEX "task_messages_cloud_job_id_idx";--> statement-breakpoint
DROP INDEX "task_platform_issue_reports_cloud_job_id_created_at_idx";--> statement-breakpoint
DROP INDEX "task_start_parallel_counts_cloud_job_id_unique";--> statement-breakpoint
DROP INDEX "tasks_user_id_idx";--> statement-breakpoint
DROP INDEX "tasks_completed_idx";--> statement-breakpoint
ALTER TABLE "compute_provider_usage" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "compute_provider_usage_samples" ADD COLUMN "run_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_oidc_targets" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "task_messages" ADD COLUMN "run_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "task_platform_issue_reports" ADD COLUMN "run_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "pr_sha" text;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "pr_base_ref" text;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "pr_base_sha" text;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "github_reaction_id" bigint;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "github_check_run_id" bigint;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "github_review_comment_id" bigint;--> statement-breakpoint
ALTER TABLE "task_start_parallel_counts" ADD COLUMN "run_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "task_start_parallel_counts" ADD COLUMN "payload_kind" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "workflow" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "surface" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "trigger" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "visibility" text DEFAULT 'visible' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "initiator_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "initiator_user_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "initiator_automation" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "actor_external_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "actor_display_name" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "commit_author_kind" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "commit_author_user_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "commit_author_login" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "commit_author_external_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "pr_assignee_login" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "slack_thread_ts" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "linear_session_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "linear_issue_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "linear_organization_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "draft_prompt" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_work_kind" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_work_kind_source" text DEFAULT 'system_default' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "requested_work_kind_confidence" real;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "harness_instructions" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "task_run_events" ADD CONSTRAINT "task_run_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_events" ADD CONSTRAINT "task_run_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_source_run_id_task_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."task_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_acting_user_id_users_id_fk" FOREIGN KEY ("acting_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_run_events_run_id_created_at_idx" ON "task_run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "task_run_events_task_id_created_at_idx" ON "task_run_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_run_events_created_at_idx" ON "task_run_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "task_run_events_source_created_at_idx" ON "task_run_events" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "task_runs_task_id_idx" ON "task_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_runs_acting_user_id_idx" ON "task_runs" USING btree ("acting_user_id");--> statement-breakpoint
CREATE INDEX "task_runs_snapshot_id_idx" ON "task_runs" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "task_runs_sleep_at_idx" ON "task_runs" USING btree ("sleep_at");--> statement-breakpoint
CREATE INDEX "task_runs_worker_heartbeat_at_idx" ON "task_runs" USING btree ("worker_heartbeat_at");--> statement-breakpoint
CREATE INDEX "task_runs_sleep_check_due_idx" ON "task_runs" USING btree ("sleep_at","created_at","vendor") WHERE "task_runs"."status" IN ('running', 'idle') AND "task_runs"."machine_id" IS NOT NULL AND "task_runs"."sleep_at" IS NOT NULL AND "task_runs"."sleep_requested_at" IS NULL AND "task_runs"."snapshot_id" IS NULL AND "task_runs"."snapshot_requested_at" IS NULL AND "task_runs"."vendor" IN ('modal', 'daytona', 'e2b');--> statement-breakpoint
CREATE INDEX "task_runs_sleep_check_stale_worker_idx" ON "task_runs" USING btree ("worker_heartbeat_at","created_at","vendor") WHERE "task_runs"."status" IN ('running', 'idle') AND "task_runs"."machine_id" IS NOT NULL AND "task_runs"."worker_heartbeat_at" IS NOT NULL AND "task_runs"."sleep_requested_at" IS NULL AND "task_runs"."snapshot_id" IS NULL AND "task_runs"."snapshot_requested_at" IS NULL AND "task_runs"."vendor" IN ('modal', 'daytona', 'e2b');--> statement-breakpoint
CREATE INDEX "task_runs_sleep_check_active_idx" ON "task_runs" USING btree ("vendor","created_at" DESC NULLS LAST) WHERE "task_runs"."status" IN ('running', 'idle') AND "task_runs"."machine_id" IS NOT NULL AND "task_runs"."sleep_requested_at" IS NULL AND "task_runs"."snapshot_id" IS NULL AND "task_runs"."snapshot_requested_at" IS NULL AND "task_runs"."vendor" IN ('modal', 'daytona', 'e2b');--> statement-breakpoint
CREATE INDEX "task_runs_source_snapshot_id_idx" ON "task_runs" USING btree ("source_snapshot_id");--> statement-breakpoint
CREATE INDEX "task_runs_source_run_id_idx" ON "task_runs" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "task_runs_first_assistant_output_at_idx" ON "task_runs" USING btree ("first_assistant_output_at");--> statement-breakpoint
ALTER TABLE "compute_provider_usage" ADD CONSTRAINT "compute_provider_usage_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_provider_usage_samples" ADD CONSTRAINT "compute_provider_usage_samples_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_oidc_targets" ADD CONSTRAINT "sandbox_oidc_targets_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" ADD CONSTRAINT "slack_conversation_messages_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD CONSTRAINT "task_inference_usage_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_platform_issue_reports" ADD CONSTRAINT "task_platform_issue_reports_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_start_parallel_counts" ADD CONSTRAINT "task_start_parallel_counts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_start_parallel_counts" ADD CONSTRAINT "task_start_parallel_counts_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_commit_author_user_id_users_id_fk" FOREIGN KEY ("commit_author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compute_provider_usage_run_id_idx" ON "compute_provider_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "compute_provider_usage_samples_run_id_idx" ON "compute_provider_usage_samples" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "sandbox_oidc_targets_run_id_idx" ON "sandbox_oidc_targets" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "slack_conversation_messages_run_id_idx" ON "slack_conversation_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_artifacts_run_id_idx" ON "task_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_inference_usage_events_run_id_idx" ON "task_inference_usage_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_messages_run_id_idx" ON "task_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_platform_issue_reports_run_id_created_at_idx" ON "task_platform_issue_reports" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_start_parallel_counts_run_id_unique" ON "task_start_parallel_counts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tasks_initiator_user_id_idx" ON "tasks" USING btree ("initiator_user_id");--> statement-breakpoint
CREATE INDEX "tasks_initiator_automation_idx" ON "tasks" USING btree ("initiator_automation");--> statement-breakpoint
CREATE INDEX "tasks_workflow_idx" ON "tasks" USING btree ("workflow");--> statement-breakpoint
CREATE INDEX "tasks_visibility_activity_at_idx" ON "tasks" USING btree ("visibility","activity_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "compute_provider_usage" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "compute_provider_usage" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "compute_provider_usage_samples" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "compute_provider_usage_samples" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "sandbox_oidc_targets" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "task_artifacts" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "task_messages" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "task_platform_issue_reports" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "task_start_parallel_counts" DROP COLUMN "cloud_job_id";--> statement-breakpoint
ALTER TABLE "task_start_parallel_counts" DROP COLUMN "cloud_job_type";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "attribution_kind";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "attributed_user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "attribution_source_kind";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "attribution_source_display_name";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "attribution_source_external_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "attributed_github_login";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "attributed_github_user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_author_kind";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_author_user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_author_display_name";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_author_github_login";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_author_github_user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_author_reason";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_author_rule_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_pr_owner_kind";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_pr_owner_user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_pr_owner_display_name";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_pr_owner_github_login";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_pr_owner_reason";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "effective_pr_owner_rule_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "completed";--> statement-breakpoint
ALTER TABLE "sandbox_oidc_targets" ADD CONSTRAINT "sandbox_oidc_targets_owner_required" CHECK (run_id IS NOT NULL);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_initiator_shape_check" CHECK (("tasks"."initiator_kind" = 'user' AND "tasks"."initiator_automation" IS NULL AND ("tasks"."initiator_user_id" IS NOT NULL OR "tasks"."actor_external_id" IS NOT NULL)) OR ("tasks"."initiator_kind" = 'automation' AND "tasks"."initiator_automation" IS NOT NULL AND "tasks"."initiator_user_id" IS NULL));