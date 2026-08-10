CREATE TABLE "pr_review_aggregate_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_aggregate_events_aggregate_event_unique" UNIQUE("aggregate_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "pr_review_aggregates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"source_control_provider" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"review_head_sha" text DEFAULT 'unknown' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"follow_up_question" text,
	"follow_up_prompt" text,
	"dismissed_version" integer,
	"latest_event_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_aggregates_task_pr_head_unique" UNIQUE("task_id","source_control_provider","repository","pr_number","review_head_sha")
);
--> statement-breakpoint
CREATE TABLE "pr_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_control_provider" text NOT NULL,
	"event_key" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text NOT NULL,
	"review_head_sha" text DEFAULT 'unknown' NOT NULL,
	"kind" text NOT NULL,
	"author_login" text NOT NULL,
	"roomote_authored" boolean DEFAULT false NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_events_provider_event_key_unique" UNIQUE("source_control_provider","event_key"),
	CONSTRAINT "pr_review_events_kind_check" CHECK ("pr_review_events"."kind" in ('review', 'review_comment', 'review_summary'))
);
--> statement-breakpoint
CREATE TABLE "pr_review_fix_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"source_control_provider" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"aggregate_id" uuid,
	"run_id" integer,
	"action" text NOT NULL,
	"acting_user_id" text,
	"acquired_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_fix_claims_task_pr_unique" UNIQUE("task_id","source_control_provider","repository","pr_number")
);
--> statement-breakpoint
CREATE TABLE "pr_review_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"state" text DEFAULT 'waiting_for_idle' NOT NULL,
	"aggregate_version" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"eligible_at" timestamp,
	"next_attempt_at" timestamp,
	"alert_emitted_at" timestamp,
	"last_error" text,
	"chat_provider" text,
	"chat_channel_id" text,
	"chat_thread_id" text,
	"chat_service_url" text,
	"chat_message_id" text,
	"task_message_id" uuid,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_notification_deliveries_aggregate_dest_unique" UNIQUE("aggregate_id","destination"),
	CONSTRAINT "pr_review_notification_deliveries_destination_check" CHECK ("pr_review_notification_deliveries"."destination" in ('task_history', 'chat')),
	CONSTRAINT "pr_review_notification_deliveries_state_check" CHECK ("pr_review_notification_deliveries"."state" in ('waiting_for_idle', 'pending', 'sending', 'delivered', 'failed', 'unknown', 'skipped', 'dead_letter'))
);
--> statement-breakpoint
ALTER TABLE "pr_review_aggregate_events" ADD CONSTRAINT "pr_review_aggregate_events_aggregate_id_pr_review_aggregates_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."pr_review_aggregates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_aggregate_events" ADD CONSTRAINT "pr_review_aggregate_events_event_id_pr_review_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."pr_review_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_aggregates" ADD CONSTRAINT "pr_review_aggregates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_fix_claims" ADD CONSTRAINT "pr_review_fix_claims_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_fix_claims" ADD CONSTRAINT "pr_review_fix_claims_aggregate_id_pr_review_aggregates_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."pr_review_aggregates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_fix_claims" ADD CONSTRAINT "pr_review_fix_claims_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_fix_claims" ADD CONSTRAINT "pr_review_fix_claims_acting_user_id_users_id_fk" FOREIGN KEY ("acting_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_deliveries" ADD CONSTRAINT "pr_review_notification_deliveries_aggregate_id_pr_review_aggregates_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."pr_review_aggregates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_notification_deliveries" ADD CONSTRAINT "pr_review_notification_deliveries_task_message_id_task_messages_id_fk" FOREIGN KEY ("task_message_id") REFERENCES "public"."task_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pr_review_aggregate_events_event_idx" ON "pr_review_aggregate_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "pr_review_aggregates_pr_idx" ON "pr_review_aggregates" USING btree ("source_control_provider","repository","pr_number");--> statement-breakpoint
CREATE INDEX "pr_review_events_pr_received_idx" ON "pr_review_events" USING btree ("source_control_provider","repository","pr_number","received_at");--> statement-breakpoint
CREATE INDEX "pr_review_fix_claims_run_idx" ON "pr_review_fix_claims" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "pr_review_notification_deliveries_due_idx" ON "pr_review_notification_deliveries" USING btree ("state","next_attempt_at");