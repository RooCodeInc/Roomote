CREATE TABLE "pr_review_auto_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_control_provider" text NOT NULL,
	"host" text,
	"repository_id" uuid,
	"repository_identity_key" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"enabled_by_user_id" text NOT NULL,
	"enabled_at" timestamp DEFAULT now() NOT NULL,
	"source_task_id" text,
	"source_destination_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pr_review_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_unit_id" uuid NOT NULL,
	"destination_kind" text NOT NULL,
	"destination_key" text NOT NULL,
	"task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp NOT NULL,
	"deferrals" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"route_provider" text,
	"route_workspace_id" text,
	"route_channel_id" text,
	"route_thread_id" text,
	"follow_up_prompt" text,
	"target_task_id" text,
	"acting_user_id" text,
	"provider_message_id" text,
	"action_claimed_at" timestamp,
	"dispatch_key" text NOT NULL,
	"dispatched_run_id" integer,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_notification_deliveries_destination_kind_check" CHECK ("pr_review_notification_deliveries"."destination_kind" in ('fast_conversation', 'task')),
	CONSTRAINT "pr_review_notification_deliveries_status_check" CHECK ("pr_review_notification_deliveries"."status" in ('pending', 'claimed', 'prepared', 'prompt_posting', 'awaiting_user_action', 'auto_dispatch_pending', 'completed', 'suppressed', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "pr_review_notification_unit_events" (
	"unit_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attached_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_notification_unit_events_pk" PRIMARY KEY("unit_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "pr_review_notification_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_control_provider" text NOT NULL,
	"host" text,
	"repository_id" uuid,
	"repository_identity_key" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"head_sha" text,
	"episode_kind" text NOT NULL,
	"episode_id" text NOT NULL,
	"due_at" timestamp NOT NULL,
	"first_observed_at" timestamp NOT NULL,
	"last_observed_at" timestamp NOT NULL,
	"sealed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_notification_units_episode_kind_check" CHECK ("pr_review_notification_units"."episode_kind" in ('roomote_cycle', 'human', 'automated', 'ci'))
);
--> statement-breakpoint
ALTER TABLE "pr_review_auto_preferences" ADD CONSTRAINT "pr_review_auto_preferences_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_auto_preferences" ADD CONSTRAINT "pr_review_auto_preferences_enabled_by_user_id_users_id_fk" FOREIGN KEY ("enabled_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_auto_preferences" ADD CONSTRAINT "pr_review_auto_preferences_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_deliveries" ADD CONSTRAINT "pr_review_notification_deliveries_notification_unit_id_pr_review_notification_units_id_fk" FOREIGN KEY ("notification_unit_id") REFERENCES "public"."pr_review_notification_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_deliveries" ADD CONSTRAINT "pr_review_notification_deliveries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_deliveries" ADD CONSTRAINT "pr_review_notification_deliveries_target_task_id_tasks_id_fk" FOREIGN KEY ("target_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_deliveries" ADD CONSTRAINT "pr_review_notification_deliveries_acting_user_id_users_id_fk" FOREIGN KEY ("acting_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_unit_events" ADD CONSTRAINT "pr_review_notification_unit_events_unit_id_pr_review_notification_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."pr_review_notification_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_unit_events" ADD CONSTRAINT "pr_review_notification_unit_events_event_id_pr_review_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."pr_review_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_units" ADD CONSTRAINT "pr_review_notification_units_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_auto_preferences_identity_unique" ON "pr_review_auto_preferences" USING btree ("source_control_provider","repository_identity_key","pr_number");--> statement-breakpoint
CREATE INDEX "pr_review_auto_preferences_repository_idx" ON "pr_review_auto_preferences" USING btree ("source_control_provider","repository","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_notification_deliveries_destination_unique" ON "pr_review_notification_deliveries" USING btree ("notification_unit_id","destination_kind","destination_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_notification_deliveries_dispatch_key_unique" ON "pr_review_notification_deliveries" USING btree ("dispatch_key");--> statement-breakpoint
CREATE INDEX "pr_review_notification_deliveries_due_idx" ON "pr_review_notification_deliveries" USING btree ("status","due_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "pr_review_notification_deliveries_destination_idx" ON "pr_review_notification_deliveries" USING btree ("destination_kind","destination_key");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_notification_unit_events_event_unique" ON "pr_review_notification_unit_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_notification_units_identity_unique" ON "pr_review_notification_units" USING btree ("source_control_provider","repository_identity_key","pr_number","episode_kind","episode_id");--> statement-breakpoint
CREATE INDEX "pr_review_notification_units_open_head_idx" ON "pr_review_notification_units" USING btree ("source_control_provider","repository","pr_number","head_sha","sealed_at");
--> statement-breakpoint
INSERT INTO "pr_review_auto_preferences" (
	"source_control_provider",
	"host",
	"repository_id",
	"repository_identity_key",
	"repository",
	"pr_number",
	"enabled_by_user_id",
	"enabled_at",
	"source_task_id",
	"created_at",
	"updated_at"
)
SELECT DISTINCT ON (
	"source_control_provider",
	coalesce('id:' || "repository_id"::text, 'name:' || coalesce(lower("host"), '') || ':' || lower("repository")),
	"pr_number"
)
	"source_control_provider",
	"host",
	"repository_id",
	coalesce('id:' || "repository_id"::text, 'name:' || coalesce(lower("host"), '') || ':' || lower("repository")),
	"repository",
	"pr_number",
	"auto_handle_feedback_by_user_id",
	"updated_at",
	"task_id",
	"created_at",
	"updated_at"
FROM "task_pull_requests"
WHERE "auto_handle_feedback_by_user_id" IS NOT NULL
	AND "repository" IS NOT NULL
	AND "pr_number" IS NOT NULL
ORDER BY
	"source_control_provider",
	coalesce('id:' || "repository_id"::text, 'name:' || coalesce(lower("host"), '') || ':' || lower("repository")),
	"pr_number",
	"updated_at" DESC,
	"id" DESC
ON CONFLICT ("source_control_provider", "repository_identity_key", "pr_number")
DO NOTHING;
