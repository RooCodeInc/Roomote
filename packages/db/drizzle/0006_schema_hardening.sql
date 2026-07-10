ALTER TABLE "tasks" RENAME COLUMN "provider" TO "model_provider";--> statement-breakpoint
ALTER TABLE "webhooks" DROP CONSTRAINT "webhooks_delivery_id_unique";--> statement-breakpoint
DROP INDEX "repositories_provider_external_repo_unique";--> statement-breakpoint
DROP INDEX "repositories_provider_full_name_unique";--> statement-breakpoint
DROP INDEX "webhooks_provider_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_host_external_repo_unique" ON "repositories" USING btree ("source_control_provider",coalesce("host", ''),"external_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_provider_host_full_name_unique" ON "repositories" USING btree ("source_control_provider",coalesce("host", ''),"full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_provider_delivery_id_unique" ON "webhooks" USING btree ("provider","delivery_id");--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_kind_check" CHECK ("task_runs"."kind" in ('fresh', 'resume'));--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_harness_check" CHECK ("task_runs"."harness" in ('opencode-server'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workflow_check" CHECK ("tasks"."workflow" in ('standard', 'pr_review', 'pr_conflict_resolve', 'scan', 'mcp_recommendations', 'setup_onboarding', 'env_snapshot', 'eval'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_surface_check" CHECK ("tasks"."surface" in ('web', 'api', 'slack', 'teams', 'telegram', 'linear', 'github', 'gitlab', 'gitea', 'ado', 'system'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_trigger_check" CHECK ("tasks"."trigger" in ('message', 'webhook', 'schedule', 'manual'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_visibility_check" CHECK ("tasks"."visibility" in ('visible', 'hidden'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_state_check" CHECK ("tasks"."state" in ('active', 'completed', 'failed', 'canceled'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_harness_check" CHECK ("tasks"."harness" in ('opencode-server'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requested_work_kind_check" CHECK ("tasks"."requested_work_kind" in ('question', 'plan', 'implement', 'unknown'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requested_work_kind_source_check" CHECK ("tasks"."requested_work_kind_source" in ('explicit_bootstrap', 'task_tool', 'llm_classifier', 'inherited', 'system_default'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_commit_author_kind_check" CHECK ("tasks"."commit_author_kind" IS NULL OR "tasks"."commit_author_kind" in ('roomote', 'user', 'external'));