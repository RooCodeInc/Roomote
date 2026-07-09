CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"schedule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"instructions" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_at" timestamp,
	"last_succeeded_at" timestamp,
	"last_failed_at" timestamp,
	"last_error" text,
	"scan_cursor" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_provider_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_usage_id" text NOT NULL,
	"auth_kind" text NOT NULL,
	"run_id" integer,
	"task_id" text,
	"instance_id" text,
	"launch_mode" text,
	"lifecycle_action" text NOT NULL,
	"measurement_source" text NOT NULL,
	"configured_vcpus" integer,
	"configured_cpu_cores" real,
	"configured_memory_mib" integer,
	"wall_clock_duration_ms" bigint,
	"active_cpu_duration_ms" bigint,
	"observed_memory_mib_milliseconds" bigint,
	"network_ingress_bytes" bigint,
	"network_egress_bytes" bigint,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compute_provider_usage_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_usage_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"task_id" text,
	"instance_id" text,
	"sampled_at" timestamp NOT NULL,
	"cpu_usage_ns_total" bigint,
	"memory_usage_bytes" bigint,
	"memory_peak_usage_bytes" bigint,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_mcp_enablements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mcp_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"enabled_by_user_id" text,
	"disabled_tools" text[],
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_mcp_enablements_mcp_unique" UNIQUE("mcp_id")
);
--> statement-breakpoint
CREATE TABLE "deployment_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"task_model_settings" jsonb,
	"router_debug_slack_channel_id" text,
	"runtime_model_config" jsonb,
	"runtime_compute_config" jsonb,
	"access_policy" jsonb,
	"license_key" text,
	"instance_analytics_id" text,
	"latest_known_version" text,
	"latest_version_checked_at" timestamp,
	"setup_completed_at" timestamp,
	"setup_new_state" jsonb,
	"slack_onboarding_stage" text,
	"manager_slack_channel_id" text,
	"global_agent_instructions" text,
	"authorship_instructions" text,
	"compiled_authorship_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compiled_authorship_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compiled_authorship_at" timestamp,
	"style_guidance" text,
	"slack_summon_emoji" text,
	"slack_ack_emoji" text DEFAULT 'eyes' NOT NULL,
	"slack_completion_emoji" text DEFAULT 'white_check_mark' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_repository_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "env_repo_mappings_unique" UNIQUE("environment_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "environment_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"snapshot_id" text,
	"snapshot_created_at" timestamp,
	"snapshot_expires_at" timestamp,
	"snapshot_status" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"last_updated_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"description" text,
	"config" jsonb NOT NULL,
	"is_eval" boolean DEFAULT false NOT NULL,
	"declarative_source" text,
	"snapshot_id" text,
	"snapshot_created_at" timestamp,
	"snapshot_expires_at" timestamp,
	"snapshot_status" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"installation_id" bigint NOT NULL,
	"app_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"installed_by_user_id" text NOT NULL,
	"members_count" integer,
	"suspended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_pending_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"requested_by_user_id" text NOT NULL,
	"app_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_login" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_user_mappings_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"invited_by_user_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linear_pending_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"linear_organization_id" text NOT NULL,
	"user_id" text,
	"step" text DEFAULT 'awaiting_workspace' NOT NULL,
	"payload" jsonb NOT NULL,
	"selected_repo" text,
	"workspace_options" jsonb,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "linear_pending_selections_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"mcp_id" text NOT NULL,
	"connection_role" text DEFAULT 'default' NOT NULL,
	"auth_config" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"auth_status" text,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp,
	"scopes" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connections_user_mcp_id_unique" UNIQUE NULLS NOT DISTINCT("user_id","mcp_id","connection_role")
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"connection_id" uuid,
	"user_id" text,
	"mcp_id" text NOT NULL,
	"connection_role" text DEFAULT 'default' NOT NULL,
	"session_id" text,
	"payload" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redirect_to" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_replays_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "microsoft_auth_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"microsoft_tenant_id" text NOT NULL,
	"microsoft_aad_object_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_state" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"code_verifier" text NOT NULL,
	"replay_token" text,
	"expires_at" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_request_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"repository_full_name" text NOT NULL,
	"source_control_provider" text DEFAULT 'github' NOT NULL,
	"external_pull_request_id" bigint NOT NULL,
	"pr_number" integer NOT NULL,
	"title" text NOT NULL,
	"html_url" text NOT NULL,
	"author_login" text,
	"state" text NOT NULL,
	"created_at_remote" timestamp NOT NULL,
	"updated_at_remote" timestamp NOT NULL,
	"closed_at_remote" timestamp,
	"merged_at_remote" timestamp,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_facts_source_control_provider_check" CHECK ("pull_request_facts"."source_control_provider" in ('github', 'gitlab', 'gitea', 'ado'))
);
--> statement-breakpoint
CREATE TABLE "pull_request_sync_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"last_incremental_updated_at" timestamp,
	"backfill_completed_at" timestamp,
	"cooldown_until" timestamp,
	"last_successful_sync_at" timestamp,
	"last_attempted_sync_at" timestamp,
	"last_error_at" timestamp,
	"last_error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_control_provider" text DEFAULT 'github' NOT NULL,
	"installation_id" uuid,
	"user_id" text,
	"github_repo_id" bigint,
	"external_repo_id" text,
	"host" text,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"description" text,
	"private" boolean DEFAULT false NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"clone_url" text NOT NULL,
	"html_url" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"linked_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_source_control_provider_check" CHECK ("repositories"."source_control_provider" in ('github', 'gitlab', 'gitea', 'ado')),
	CONSTRAINT "repositories_github_shape_check" CHECK ("repositories"."source_control_provider" != 'github' OR ("repositories"."installation_id" IS NOT NULL AND "repositories"."github_repo_id" IS NOT NULL)),
	CONSTRAINT "repositories_gitlab_shape_check" CHECK ("repositories"."source_control_provider" != 'gitlab' OR "repositories"."external_repo_id" IS NOT NULL),
	CONSTRAINT "repositories_gitea_shape_check" CHECK ("repositories"."source_control_provider" != 'gitea' OR "repositories"."external_repo_id" IS NOT NULL),
	CONSTRAINT "repositories_ado_shape_check" CHECK ("repositories"."source_control_provider" != 'ado' OR "repositories"."external_repo_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sandbox_oidc_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"run_id" integer,
	"compute_provider" text NOT NULL,
	"compute_provider_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"audience" text NOT NULL,
	"token_file" text NOT NULL,
	"aws_role_arn" text,
	"aws_region" text,
	"refresh_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_oidc_targets_owner_required" CHECK (run_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "setup_qualification_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'blocked' NOT NULL,
	"email" text,
	"email_domain" text,
	"github_account_login" text,
	"github_account_type" text,
	"first_blocked_at" timestamp DEFAULT now() NOT NULL,
	"last_blocked_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"lifted_by_admin_user_id" text,
	"lifted_by_admin_email" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"channel" text NOT NULL,
	"thread_ts" text NOT NULL,
	"original_text" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_auth_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "slack_conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" text,
	"slack_team_id" text NOT NULL,
	"subject_slack_user_id" text NOT NULL,
	"sender_user_id" text,
	"sender_slack_user_id" text,
	"slack_channel_id" text NOT NULL,
	"conversation_kind" text NOT NULL,
	"thread_ts" text,
	"message_ts" text NOT NULL,
	"message_at" timestamp NOT NULL,
	"direction" text NOT NULL,
	"author_kind" text NOT NULL,
	"source" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"task_id" text,
	"run_id" integer,
	"slack_quick_answer_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_installation_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_installation_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_installation_channels_unique" UNIQUE("slack_installation_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "slack_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"team_domain" text,
	"enterprise_id" text,
	"enterprise_name" text,
	"app_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"bot_access_token" text NOT NULL,
	"user_access_token" text,
	"scopes" jsonb NOT NULL,
	"token_type" text DEFAULT 'bot' NOT NULL,
	"installed_by_user_id" text NOT NULL,
	"member_count_snapshot" integer,
	"member_count_snapshot_at" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_installations_team_id_unique" UNIQUE("team_id")
);
--> statement-breakpoint
CREATE TABLE "slack_quick_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"slack_channel" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_user_mappings_unique" UNIQUE("slack_user_id","slack_team_id")
);
--> statement-breakpoint
CREATE TABLE "task_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"run_id" integer,
	"artifact_type" text DEFAULT 'general' NOT NULL,
	"content_type" text NOT NULL,
	"path" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"size" bigint NOT NULL,
	"uploaded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_artifacts_task_id_path_version_unique" UNIQUE("task_id","path","version")
);
--> statement-breakpoint
CREATE TABLE "task_inference_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text DEFAULT 'opencode' NOT NULL,
	"task_id" text NOT NULL,
	"run_id" integer,
	"harness_session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"provider_id" text,
	"model_id" text,
	"agent" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"context_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"cost_source" text NOT NULL,
	"message_created_at" timestamp,
	"message_completed_at" timestamp,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" integer NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text,
	"ts" bigint NOT NULL,
	"event_type" text NOT NULL,
	"role" text,
	"protocol" text NOT NULL,
	"content_schema" text NOT NULL,
	"content_blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"payload" jsonb NOT NULL,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_messages_task_protocol_ts_event_type_unique" UNIQUE("task_id","protocol","ts","event_type")
);
--> statement-breakpoint
CREATE TABLE "task_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_platform_issue_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"task_message_id" uuid,
	"report" jsonb NOT NULL,
	"slack_posted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"source_control_provider" text DEFAULT 'github' NOT NULL,
	"host" text,
	"repository_id" uuid,
	"pr_url" text NOT NULL,
	"pr_number" integer,
	"pr_title" text,
	"repository" text,
	"pr_sha" text,
	"pr_base_ref" text,
	"pr_base_sha" text,
	"github_reaction_id" bigint,
	"github_check_run_id" bigint,
	"github_review_comment_id" bigint,
	"status" text,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_pull_requests_task_pr_unique" UNIQUE("task_id","pr_url"),
	CONSTRAINT "task_pull_requests_source_control_provider_check" CHECK ("task_pull_requests"."source_control_provider" in ('github', 'gitlab', 'gitea', 'ado'))
);
--> statement-breakpoint
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
CREATE TABLE "task_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"share_token" text NOT NULL,
	"visibility" text DEFAULT 'deployment' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_shares_share_token_unique" UNIQUE("share_token")
);
--> statement-breakpoint
CREATE TABLE "task_slack_reply_details" (
	"detail_id" uuid PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"summary" text,
	"findings" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_start_parallel_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"payload_kind" text,
	"parallel_count" integer NOT NULL,
	"activity_window_seconds" integer NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow" text NOT NULL,
	"surface" text NOT NULL,
	"trigger" text NOT NULL,
	"visibility" text DEFAULT 'visible' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"initiator_kind" text NOT NULL,
	"initiator_user_id" text,
	"initiator_automation" text,
	"actor_external_id" text,
	"actor_display_name" text,
	"commit_author_kind" text,
	"commit_author_user_id" text,
	"commit_author_login" text,
	"commit_author_external_id" text,
	"pr_assignee_login" text,
	"slack_channel_id" text,
	"slack_thread_ts" text,
	"linear_session_id" text,
	"linear_issue_id" text,
	"linear_organization_id" text,
	"harness" text DEFAULT 'opencode-server' NOT NULL,
	"harness_session_id" text,
	"provider" text NOT NULL,
	"title" text NOT NULL,
	"title_edited_by_user_at" timestamp,
	"llm_title_checkpoint" integer DEFAULT 0 NOT NULL,
	"mode" text,
	"model" text NOT NULL,
	"prompt" text,
	"draft_prompt" text,
	"requested_work_kind" text DEFAULT 'unknown' NOT NULL,
	"requested_work_kind_source" text DEFAULT 'system_default' NOT NULL,
	"requested_work_kind_confidence" real,
	"harness_instructions" text,
	"compute_duration_ms" bigint DEFAULT 0 NOT NULL,
	"timestamp" integer NOT NULL,
	"activity_at" bigint NOT NULL,
	"repository_url" text,
	"repository_name" text,
	"default_branch" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_initiator_shape_check" CHECK (("tasks"."initiator_kind" = 'user' AND "tasks"."initiator_automation" IS NULL AND ("tasks"."initiator_user_id" IS NOT NULL OR "tasks"."actor_external_id" IS NOT NULL)) OR ("tasks"."initiator_kind" = 'automation' AND "tasks"."initiator_automation" IS NOT NULL AND "tasks"."initiator_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "teams_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_key" text NOT NULL,
	"tenant_id" text NOT NULL,
	"team_id" text,
	"team_name" text,
	"channel_id" text,
	"channel_name" text,
	"conversation_id" text NOT NULL,
	"conversation_type" text,
	"bot_app_id" text NOT NULL,
	"bot_user_id" text,
	"bot_name" text,
	"service_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_activity_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "teams_installations_installation_key_unique" UNIQUE("installation_key")
);
--> statement-breakpoint
CREATE TABLE "teams_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teams_user_id" text NOT NULL,
	"teams_tenant_id" text NOT NULL,
	"teams_aad_object_id" text,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "teams_user_mappings_unique" UNIQUE("teams_user_id","teams_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" text NOT NULL,
	"telegram_chat_id" text NOT NULL,
	"telegram_username" text,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_user_mappings_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE "tracked_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surface" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text,
	"thread_ts" text,
	"work_item_id" uuid,
	"automation_key" text,
	"created_by_user_id" text,
	"summary_text" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"posted_at" timestamp DEFAULT now() NOT NULL,
	"dismissed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"api_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"image_url" text NOT NULL,
	"entity" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"analytics_id" text,
	"onboarding_completed_at" timestamp,
	"invited_by_invite_id" uuid,
	"last_sync_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" text NOT NULL,
	"provider" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"succeeded_at" timestamp,
	"failed_at" timestamp,
	"ignored_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_delivery_id_unique" UNIQUE("delivery_id"),
	CONSTRAINT "webhooks_status_exclusive" CHECK ((
        (succeeded_at IS NOT NULL)::int +
        (failed_at IS NOT NULL)::int +
        (ignored_at IS NOT NULL)::int
      ) <= 1)
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"automation_key" text,
	"source_task_id" text,
	"selected_by_user_id" text,
	"source_work_item_id" uuid,
	"title" text NOT NULL,
	"brief" text,
	"execution_prompt" text,
	"investigation_context" text,
	"category" text,
	"priority" text,
	"action_kind" text,
	"disposition" text,
	"sort_order" integer NOT NULL,
	"repository_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_repository_full_name" text,
	"target_environment_id" uuid,
	"workspace_readiness" text,
	"readiness_message" text,
	"fingerprint" text,
	"status" text DEFAULT 'open' NOT NULL,
	"launch_claimed_at" timestamp,
	"launched_task_id" text,
	"launched_at" timestamp,
	"failed_at" timestamp,
	"launch_error" text,
	"dismissed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_provider_usage" ADD CONSTRAINT "compute_provider_usage_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_provider_usage" ADD CONSTRAINT "compute_provider_usage_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_provider_usage_samples" ADD CONSTRAINT "compute_provider_usage_samples_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_provider_usage_samples" ADD CONSTRAINT "compute_provider_usage_samples_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_mcp_enablements" ADD CONSTRAINT "deployment_mcp_enablements_enabled_by_user_id_users_id_fk" FOREIGN KEY ("enabled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_config_versions" ADD CONSTRAINT "environment_config_versions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_config_versions" ADD CONSTRAINT "environment_config_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_repository_mappings" ADD CONSTRAINT "environment_repository_mappings_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_repository_mappings" ADD CONSTRAINT "environment_repository_mappings_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_snapshots" ADD CONSTRAINT "environment_snapshots_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_last_updated_by_user_id_users_id_fk" FOREIGN KEY ("last_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pending_installations" ADD CONSTRAINT "github_pending_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_pending_installations" ADD CONSTRAINT "github_pending_installations_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_user_mappings" ADD CONSTRAINT "github_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linear_pending_selections" ADD CONSTRAINT "linear_pending_selections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_replays" ADD CONSTRAINT "mcp_oauth_replays_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_replays" ADD CONSTRAINT "mcp_oauth_replays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microsoft_auth_user_mappings" ADD CONSTRAINT "microsoft_auth_user_mappings_auth_account_id_auth_accounts_id_fk" FOREIGN KEY ("auth_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microsoft_auth_user_mappings" ADD CONSTRAINT "microsoft_auth_user_mappings_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD CONSTRAINT "pull_request_facts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_sync_states" ADD CONSTRAINT "pull_request_sync_states_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_linked_by_user_id_users_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_oidc_targets" ADD CONSTRAINT "sandbox_oidc_targets_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_oidc_targets" ADD CONSTRAINT "sandbox_oidc_targets_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_qualification_blocks" ADD CONSTRAINT "setup_qualification_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" ADD CONSTRAINT "slack_conversation_messages_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" ADD CONSTRAINT "slack_conversation_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" ADD CONSTRAINT "slack_conversation_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" ADD CONSTRAINT "slack_conversation_messages_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_conversation_messages" ADD CONSTRAINT "slack_conversation_messages_slack_quick_answer_id_slack_quick_answers_id_fk" FOREIGN KEY ("slack_quick_answer_id") REFERENCES "public"."slack_quick_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installation_channels" ADD CONSTRAINT "slack_installation_channels_slack_installation_id_slack_installations_id_fk" FOREIGN KEY ("slack_installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_quick_answers" ADD CONSTRAINT "slack_quick_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_mappings" ADD CONSTRAINT "slack_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD CONSTRAINT "task_inference_usage_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD CONSTRAINT "task_inference_usage_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_messages" ADD CONSTRAINT "task_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pins" ADD CONSTRAINT "task_pins_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pins" ADD CONSTRAINT "task_pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_platform_issue_reports" ADD CONSTRAINT "task_platform_issue_reports_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_platform_issue_reports" ADD CONSTRAINT "task_platform_issue_reports_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_platform_issue_reports" ADD CONSTRAINT "task_platform_issue_reports_task_message_id_task_messages_id_fk" FOREIGN KEY ("task_message_id") REFERENCES "public"."task_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_events" ADD CONSTRAINT "task_run_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_events" ADD CONSTRAINT "task_run_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_source_run_id_task_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."task_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_acting_user_id_users_id_fk" FOREIGN KEY ("acting_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_shares" ADD CONSTRAINT "task_shares_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_slack_reply_details" ADD CONSTRAINT "task_slack_reply_details_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_start_parallel_counts" ADD CONSTRAINT "task_start_parallel_counts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_start_parallel_counts" ADD CONSTRAINT "task_start_parallel_counts_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_initiator_automation_automations_key_fk" FOREIGN KEY ("initiator_automation") REFERENCES "public"."automations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_commit_author_user_id_users_id_fk" FOREIGN KEY ("commit_author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_user_mappings" ADD CONSTRAINT "teams_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_user_mappings" ADD CONSTRAINT "telegram_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_messages" ADD CONSTRAINT "tracked_messages_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_messages" ADD CONSTRAINT "tracked_messages_automation_key_automations_key_fk" FOREIGN KEY ("automation_key") REFERENCES "public"."automations"("key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_messages" ADD CONSTRAINT "tracked_messages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_api_keys" ADD CONSTRAINT "user_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_automation_key_automations_key_fk" FOREIGN KEY ("automation_key") REFERENCES "public"."automations"("key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_selected_by_user_id_users_id_fk" FOREIGN KEY ("selected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_source_work_item_id_work_items_id_fk" FOREIGN KEY ("source_work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_target_environment_id_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_launched_task_id_tasks_id_fk" FOREIGN KEY ("launched_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_unique" ON "auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_unique" ON "auth_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_users_email_unique" ON "auth_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "auth_users_created_at_idx" ON "auth_users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "compute_provider_usage_provider_usage_id_unique" ON "compute_provider_usage" USING btree ("provider","provider_usage_id");--> statement-breakpoint
CREATE INDEX "compute_provider_usage_run_id_idx" ON "compute_provider_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "compute_provider_usage_task_id_idx" ON "compute_provider_usage" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "compute_provider_usage_created_at_idx" ON "compute_provider_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "compute_provider_usage_samples_provider_usage_sampled_at_unique" ON "compute_provider_usage_samples" USING btree ("provider","provider_usage_id","sampled_at");--> statement-breakpoint
CREATE INDEX "compute_provider_usage_samples_run_id_idx" ON "compute_provider_usage_samples" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "compute_provider_usage_samples_task_id_idx" ON "compute_provider_usage_samples" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "compute_provider_usage_samples_created_at_idx" ON "compute_provider_usage_samples" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_secrets_name_unique" ON "deployment_secrets" USING btree ("name");--> statement-breakpoint
CREATE INDEX "environment_config_versions_environment_id_idx" ON "environment_config_versions" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_config_versions_environment_version_unique" ON "environment_config_versions" USING btree ("environment_id","version");--> statement-breakpoint
CREATE INDEX "env_repo_mappings_env_id_idx" ON "environment_repository_mappings" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "env_repo_mappings_repo_id_idx" ON "environment_repository_mappings" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "environment_snapshots_environment_id_idx" ON "environment_snapshots" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_snapshots_env_provider_unique" ON "environment_snapshots" USING btree ("environment_id","provider") WHERE "environment_snapshots"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "environment_variables_user_id_idx" ON "environment_variables" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variables_name_unique" ON "environment_variables" USING btree ("name");--> statement-breakpoint
CREATE INDEX "environments_user_id_idx" ON "environments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "environments_created_by_user_id_idx" ON "environments" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "environments_snapshot_expires_at_idx" ON "environments" USING btree ("snapshot_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name_unique" ON "environments" USING btree ("name");--> statement-breakpoint
CREATE INDEX "github_installations_account_login_idx" ON "github_installations" USING btree ("account_login");--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_deployment_installation_unique" ON "github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_pending_installations_requested_by_user_id_idx" ON "github_pending_installations" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE INDEX "github_user_mappings_github_login_idx" ON "github_user_mappings" USING btree ("github_login");--> statement-breakpoint
CREATE INDEX "github_user_mappings_github_user_id_idx" ON "github_user_mappings" USING btree ("github_user_id");--> statement-breakpoint
CREATE INDEX "github_user_mappings_user_id_idx" ON "github_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_unique" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_created_at_idx" ON "invites" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "linear_pending_selections_session_id_idx" ON "linear_pending_selections" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "linear_pending_selections_expires_at_idx" ON "linear_pending_selections" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "linear_pending_selections_step_idx" ON "linear_pending_selections" USING btree ("step");--> statement-breakpoint
CREATE INDEX "mcp_connections_user_id_idx" ON "mcp_connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_connections_role_idx" ON "mcp_connections" USING btree ("mcp_id","connection_role");--> statement-breakpoint
CREATE INDEX "mcp_oauth_replays_connection_id_idx" ON "mcp_oauth_replays" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_replays_user_id_idx" ON "mcp_oauth_replays" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_replays_expires_at_idx" ON "mcp_oauth_replays" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "microsoft_auth_user_mappings_user_id_idx" ON "microsoft_auth_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "microsoft_auth_user_mappings_account_id_idx" ON "microsoft_auth_user_mappings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "microsoft_auth_user_mappings_auth_account_idx" ON "microsoft_auth_user_mappings" USING btree ("auth_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "microsoft_auth_user_mappings_aad_object_unique" ON "microsoft_auth_user_mappings" USING btree ("microsoft_tenant_id","microsoft_aad_object_id");--> statement-breakpoint
CREATE INDEX "oauth_state_connection_id_idx" ON "oauth_state" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "oauth_state_replay_token_idx" ON "oauth_state" USING btree ("replay_token");--> statement-breakpoint
CREATE INDEX "oauth_state_expires_at_idx" ON "oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_facts_deployment_repo_pr_unique" ON "pull_request_facts" USING btree ("repository_id","pr_number");--> statement-breakpoint
CREATE INDEX "pull_request_facts_deployment_created_idx" ON "pull_request_facts" USING btree ("created_at_remote");--> statement-breakpoint
CREATE INDEX "pull_request_facts_deployment_repo_created_idx" ON "pull_request_facts" USING btree ("repository_id","created_at_remote");--> statement-breakpoint
CREATE INDEX "pull_request_facts_deployment_state_created_idx" ON "pull_request_facts" USING btree ("state","created_at_remote");--> statement-breakpoint
CREATE INDEX "pull_request_facts_deployment_author_created_idx" ON "pull_request_facts" USING btree ("author_login","created_at_remote");--> statement-breakpoint
CREATE INDEX "pull_request_facts_deployment_updated_idx" ON "pull_request_facts" USING btree ("updated_at_remote");--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_sync_states_repo_unique" ON "pull_request_sync_states" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "pull_request_sync_states_deployment_updated_idx" ON "pull_request_sync_states" USING btree ("last_successful_sync_at");--> statement-breakpoint
CREATE INDEX "pull_request_sync_states_cooldown_idx" ON "pull_request_sync_states" USING btree ("cooldown_until");--> statement-breakpoint
CREATE INDEX "repositories_source_control_provider_idx" ON "repositories" USING btree ("source_control_provider");--> statement-breakpoint
CREATE INDEX "repositories_installation_id_idx" ON "repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "repositories_full_name_idx" ON "repositories" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "repositories_provider_full_name_idx" ON "repositories" USING btree ("source_control_provider","full_name");--> statement-breakpoint
CREATE INDEX "repositories_provider_host_full_name_idx" ON "repositories" USING btree ("source_control_provider","host","full_name");--> statement-breakpoint
CREATE INDEX "repositories_deployment_active_installation_idx" ON "repositories" USING btree ("is_active","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_deployment_github_repo_unique" ON "repositories" USING btree ("github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_external_repo_unique" ON "repositories" USING btree ("source_control_provider","external_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_full_name_unique" ON "repositories" USING btree ("source_control_provider","full_name");--> statement-breakpoint
CREATE INDEX "sandbox_oidc_targets_environment_id_idx" ON "sandbox_oidc_targets" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "sandbox_oidc_targets_run_id_idx" ON "sandbox_oidc_targets" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "sandbox_oidc_targets_refresh_at_idx" ON "sandbox_oidc_targets" USING btree ("refresh_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_oidc_targets_provider_target_file_unique" ON "sandbox_oidc_targets" USING btree ("compute_provider","compute_provider_id","token_file");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_qualification_blocks_deployment_user_reason_unique" ON "setup_qualification_blocks" USING btree ("user_id","reason");--> statement-breakpoint
CREATE INDEX "setup_qualification_blocks_deployment_status_idx" ON "setup_qualification_blocks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "setup_qualification_blocks_user_status_idx" ON "setup_qualification_blocks" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "slack_auth_tokens_token_idx" ON "slack_auth_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "slack_auth_tokens_expires_at_idx" ON "slack_auth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "slack_conversation_messages_deployment_user_message_at_idx" ON "slack_conversation_messages" USING btree ("subject_user_id","message_at");--> statement-breakpoint
CREATE INDEX "slack_conversation_messages_deployment_user_thread_idx" ON "slack_conversation_messages" USING btree ("subject_user_id","slack_channel_id","thread_ts","message_at");--> statement-breakpoint
CREATE INDEX "slack_conversation_messages_task_id_idx" ON "slack_conversation_messages" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "slack_conversation_messages_run_id_idx" ON "slack_conversation_messages" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_conversation_messages_team_channel_message_unique" ON "slack_conversation_messages" USING btree ("slack_team_id","slack_channel_id","message_ts");--> statement-breakpoint
CREATE INDEX "slack_installation_channels_installation_id_idx" ON "slack_installation_channels" USING btree ("slack_installation_id");--> statement-breakpoint
CREATE INDEX "slack_installations_team_id_idx" ON "slack_installations" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "slack_installations_bot_user_id_idx" ON "slack_installations" USING btree ("bot_user_id");--> statement-breakpoint
CREATE INDEX "slack_installations_active_idx" ON "slack_installations" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_quick_answers_deployment_channel_thread_unique" ON "slack_quick_answers" USING btree ("slack_channel","slack_thread_ts");--> statement-breakpoint
CREATE INDEX "slack_quick_answers_deployment_user_idx" ON "slack_quick_answers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "slack_user_mappings_slack_user_idx" ON "slack_user_mappings" USING btree ("slack_user_id","slack_team_id");--> statement-breakpoint
CREATE INDEX "slack_user_mappings_user_id_idx" ON "slack_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_artifacts_task_id_idx" ON "task_artifacts" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_artifacts_run_id_idx" ON "task_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_artifacts_uploaded_idx" ON "task_artifacts" USING btree ("uploaded");--> statement-breakpoint
CREATE INDEX "task_artifacts_created_at_idx" ON "task_artifacts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "task_artifacts_path_idx" ON "task_artifacts" USING btree ("task_id","path");--> statement-breakpoint
CREATE INDEX "task_artifacts_version_idx" ON "task_artifacts" USING btree ("task_id","path","version");--> statement-breakpoint
CREATE UNIQUE INDEX "task_inference_usage_events_session_message_unique" ON "task_inference_usage_events" USING btree ("harness_session_id","message_id");--> statement-breakpoint
CREATE INDEX "task_inference_usage_events_task_id_idx" ON "task_inference_usage_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_inference_usage_events_run_id_idx" ON "task_inference_usage_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_inference_usage_events_created_at_idx" ON "task_inference_usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "task_messages_task_id_ts_idx" ON "task_messages" USING btree ("task_id","ts");--> statement-breakpoint
CREATE INDEX "task_messages_run_id_idx" ON "task_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_messages_created_at_idx" ON "task_messages" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_pins_deployment_user_task_unique" ON "task_pins" USING btree ("user_id","task_id");--> statement-breakpoint
CREATE INDEX "task_pins_deployment_user_updated_at_idx" ON "task_pins" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "task_pins_task_id_idx" ON "task_pins" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_platform_issue_reports_created_at_idx" ON "task_platform_issue_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "task_platform_issue_reports_task_id_created_at_idx" ON "task_platform_issue_reports" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_platform_issue_reports_run_id_created_at_idx" ON "task_platform_issue_reports" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_platform_issue_reports_task_message_id_unique" ON "task_platform_issue_reports" USING btree ("task_message_id");--> statement-breakpoint
CREATE INDEX "task_pull_requests_task_id_idx" ON "task_pull_requests" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_pull_requests_repository_id_idx" ON "task_pull_requests" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "task_pull_requests_provider_repository_pr_number_idx" ON "task_pull_requests" USING btree ("source_control_provider","repository","pr_number");--> statement-breakpoint
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
CREATE INDEX "task_shares_share_token_idx" ON "task_shares" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "task_shares_task_id_idx" ON "task_shares" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_shares_expires_at_idx" ON "task_shares" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "task_shares_created_by_user_id_idx" ON "task_shares" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "task_shares_visibility_idx" ON "task_shares" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "task_slack_reply_details_task_id_idx" ON "task_slack_reply_details" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_slack_reply_details_deployment_task_detail_unique" ON "task_slack_reply_details" USING btree ("task_id","detail_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_start_parallel_counts_run_id_unique" ON "task_start_parallel_counts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_start_parallel_counts_task_id_started_at_idx" ON "task_start_parallel_counts" USING btree ("task_id","started_at");--> statement-breakpoint
CREATE INDEX "task_start_parallel_counts_started_at_idx" ON "task_start_parallel_counts" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "tasks_initiator_user_id_idx" ON "tasks" USING btree ("initiator_user_id");--> statement-breakpoint
CREATE INDEX "tasks_initiator_automation_idx" ON "tasks" USING btree ("initiator_automation");--> statement-breakpoint
CREATE INDEX "tasks_workflow_idx" ON "tasks" USING btree ("workflow");--> statement-breakpoint
CREATE INDEX "tasks_visibility_activity_at_idx" ON "tasks" USING btree ("visibility","activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tasks_harness_session_id_idx" ON "tasks" USING btree ("harness_session_id");--> statement-breakpoint
CREATE INDEX "tasks_timestamp_idx" ON "tasks" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "tasks_deployment_activity_at_idx" ON "tasks" USING btree ("activity_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tasks_created_at_idx" ON "tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "teams_installations_tenant_id_idx" ON "teams_installations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "teams_installations_team_id_idx" ON "teams_installations" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "teams_installations_conversation_id_idx" ON "teams_installations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "teams_installations_active_idx" ON "teams_installations" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "teams_user_mappings_teams_user_idx" ON "teams_user_mappings" USING btree ("teams_user_id","teams_tenant_id");--> statement-breakpoint
CREATE INDEX "teams_user_mappings_aad_object_idx" ON "teams_user_mappings" USING btree ("teams_aad_object_id","teams_tenant_id");--> statement-breakpoint
CREATE INDEX "teams_user_mappings_user_id_idx" ON "teams_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "telegram_user_mappings_user_id_idx" ON "telegram_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_messages_kind_dedupe_key_unique" ON "tracked_messages" USING btree ("kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "tracked_messages_work_item_id_idx" ON "tracked_messages" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "tracked_messages_channel_message_idx" ON "tracked_messages" USING btree ("channel_id","message_ts");--> statement-breakpoint
CREATE INDEX "tracked_messages_automation_channel_posted_idx" ON "tracked_messages" USING btree ("automation_key","channel_id","posted_at");--> statement-breakpoint
CREATE INDEX "user_api_keys_user_id_idx" ON "user_api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_api_keys_user_deployment_provider_unique" ON "user_api_keys" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_analytics_id_unique_idx" ON "users" USING btree ("analytics_id");--> statement-breakpoint
CREATE INDEX "webhooks_provider_idx" ON "webhooks" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "webhooks_event_idx" ON "webhooks" USING btree ("event");--> statement-breakpoint
CREATE INDEX "webhooks_created_at_idx" ON "webhooks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhooks_delivery_id_idx" ON "webhooks" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "work_items_source_task_idx" ON "work_items" USING btree ("source_task_id");--> statement-breakpoint
CREATE INDEX "work_items_kind_status_idx" ON "work_items" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "work_items_automation_key_fingerprint_idx" ON "work_items" USING btree ("automation_key","fingerprint");--> statement-breakpoint
CREATE INDEX "work_items_fingerprint_idx" ON "work_items" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "work_items_launched_task_id_idx" ON "work_items" USING btree ("launched_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_items_source_task_kind_sort_order_unique" ON "work_items" USING btree ("source_task_id","kind","sort_order");