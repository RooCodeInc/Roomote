ALTER TABLE "pull_request_facts" DROP CONSTRAINT "pull_request_facts_source_control_provider_check";--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_source_control_provider_check";--> statement-breakpoint
ALTER TABLE "task_pull_requests" DROP CONSTRAINT "task_pull_requests_source_control_provider_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_surface_check";--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD CONSTRAINT "pull_request_facts_source_control_provider_check" CHECK ("pull_request_facts"."source_control_provider" in ('github', 'gitlab', 'gitea', 'ado', 'bitbucket'));--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_bitbucket_shape_check" CHECK ("repositories"."source_control_provider" != 'bitbucket' OR "repositories"."external_repo_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_source_control_provider_check" CHECK ("repositories"."source_control_provider" in ('github', 'gitlab', 'gitea', 'ado', 'bitbucket'));--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_source_control_provider_check" CHECK ("task_pull_requests"."source_control_provider" in ('github', 'gitlab', 'gitea', 'ado', 'bitbucket'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_surface_check" CHECK ("tasks"."surface" in ('web', 'api', 'slack', 'teams', 'telegram', 'linear', 'github', 'gitlab', 'gitea', 'ado', 'bitbucket', 'system'));