ALTER TABLE "webhooks" DROP CONSTRAINT "webhooks_status_exclusive";--> statement-breakpoint
DROP INDEX "github_user_mappings_github_user_id_idx";--> statement-breakpoint
DROP INDEX "linear_pending_selections_session_id_idx";--> statement-breakpoint
DROP INDEX "repositories_provider_full_name_idx";--> statement-breakpoint
DROP INDEX "slack_auth_tokens_token_idx";--> statement-breakpoint
DROP INDEX "slack_installations_team_id_idx";--> statement-breakpoint
DROP INDEX "slack_user_mappings_slack_user_idx";--> statement-breakpoint
DROP INDEX "task_artifacts_version_idx";--> statement-breakpoint
DROP INDEX "teams_user_mappings_teams_user_idx";--> statement-breakpoint
DROP INDEX "webhooks_delivery_id_idx";--> statement-breakpoint
ALTER TABLE "task_messages" DROP COLUMN "content_schema";--> statement-breakpoint
ALTER TABLE "task_runs" DROP COLUMN "base_shas";--> statement-breakpoint
ALTER TABLE "webhooks" DROP COLUMN "ignored_at";--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_status_exclusive" CHECK ((
        (succeeded_at IS NOT NULL)::int +
        (failed_at IS NOT NULL)::int
      ) <= 1);
