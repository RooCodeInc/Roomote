CREATE TABLE "session_attention_notification_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text,
	"message_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_attention_notification_messages_provider_check" CHECK ("session_attention_notification_messages"."provider" in ('discord', 'slack', 'teams', 'telegram', 'agentmail'))
);
--> statement-breakpoint
CREATE TABLE "session_attention_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"task_id" text,
	"run_id" integer,
	"user_id" text NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"outcome" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_attention_notifications_kind_check" CHECK ("session_attention_notifications"."kind" in ('result_ready', 'input_needed')),
	CONSTRAINT "session_attention_notifications_outcome_check" CHECK ("session_attention_notifications"."outcome" IS NULL OR "session_attention_notifications"."outcome" in ('delivered', 'skipped_present', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "session_attention_notification_messages" ADD CONSTRAINT "session_attention_notification_messages_notification_id_session_attention_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."session_attention_notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD CONSTRAINT "session_attention_notifications_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD CONSTRAINT "session_attention_notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD CONSTRAINT "session_attention_notifications_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD CONSTRAINT "session_attention_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_attention_notification_messages_route_unique" ON "session_attention_notification_messages" USING btree ("provider","workspace_id","channel_id","message_id");--> statement-breakpoint
CREATE INDEX "session_attention_notification_messages_thread_idx" ON "session_attention_notification_messages" USING btree ("provider","workspace_id","channel_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_attention_notifications_event_unique" ON "session_attention_notifications" USING btree ("session_id","event_key");--> statement-breakpoint
CREATE INDEX "session_attention_notifications_run_idx" ON "session_attention_notifications" USING btree ("run_id");