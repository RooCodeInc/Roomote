CREATE TABLE "session_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"last_read_event_at" bigint,
	"last_read_event_id" text,
	"last_notified_event_at" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_participants_role_check" CHECK ("session_participants"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "session_tasks" (
	"session_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"attached_at" timestamp DEFAULT now() NOT NULL,
	"origin" text NOT NULL,
	CONSTRAINT "session_tasks_session_id_task_id_pk" PRIMARY KEY("session_id","task_id"),
	CONSTRAINT "session_tasks_origin_check" CHECK ("session_tasks"."origin" in ('direct_launch', 'fast_delegation', 'backfill', 'follow_up'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_user_id" text,
	"owner_automation" text,
	"source_surface" text NOT NULL,
	"source_trigger" text NOT NULL,
	"fast_conversation_id" uuid,
	"visibility" text DEFAULT 'visible' NOT NULL,
	"activity_at" bigint NOT NULL,
	"cached_status" text,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_owner_shape_check" CHECK (("sessions"."owner_kind" = 'user' AND "sessions"."owner_automation" IS NULL) OR ("sessions"."owner_kind" = 'automation' AND "sessions"."owner_user_id" IS NULL) OR ("sessions"."owner_kind" = 'system' AND "sessions"."owner_user_id" IS NULL AND "sessions"."owner_automation" IS NULL)),
	CONSTRAINT "sessions_owner_kind_check" CHECK ("sessions"."owner_kind" in ('user', 'automation', 'system')),
	CONSTRAINT "sessions_source_surface_check" CHECK ("sessions"."source_surface" in ('web', 'api', 'slack', 'teams', 'telegram', 'discord', 'linear', 'github', 'gitlab', 'gitea', 'ado', 'bitbucket', 'system', 'automation')),
	CONSTRAINT "sessions_source_trigger_check" CHECK ("sessions"."source_trigger" in ('message', 'webhook', 'schedule', 'manual')),
	CONSTRAINT "sessions_visibility_check" CHECK ("sessions"."visibility" in ('visible', 'hidden')),
	CONSTRAINT "sessions_cached_status_check" CHECK ("sessions"."cached_status" IS NULL OR "sessions"."cached_status" in ('active', 'needs_input', 'blocked', 'ready'))
);
--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tasks" ADD CONSTRAINT "session_tasks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tasks" ADD CONSTRAINT "session_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_automation_automations_key_fk" FOREIGN KEY ("owner_automation") REFERENCES "public"."automations"("key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_fast_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("fast_conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_participants_session_user_unique" ON "session_participants" USING btree ("session_id","user_id");--> statement-breakpoint
CREATE INDEX "session_participants_user_id_idx" ON "session_participants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_tasks_task_id_unique" ON "session_tasks" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "session_tasks_session_attached_at_idx" ON "session_tasks" USING btree ("session_id","attached_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_visibility_activity_at_idx" ON "sessions" USING btree ("visibility","activity_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_owner_user_id_idx" ON "sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_fast_conversation_id_unique" ON "sessions" USING btree ("fast_conversation_id") WHERE "sessions"."fast_conversation_id" IS NOT NULL;