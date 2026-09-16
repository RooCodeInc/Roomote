ALTER TABLE "fast_agent_conversations" ADD COLUMN "privacy" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "private_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "privacy" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "private_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD COLUMN "upload_url_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "privacy" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "private_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD CONSTRAINT "fast_agent_conversations_private_owner_user_id_users_id_fk" FOREIGN KEY ("private_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_private_owner_user_id_users_id_fk" FOREIGN KEY ("private_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_private_owner_user_id_users_id_fk" FOREIGN KEY ("private_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD CONSTRAINT "fast_agent_conversations_privacy_check" CHECK ("fast_agent_conversations"."privacy" in ('shared', 'private'));--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD CONSTRAINT "fast_agent_conversations_private_owner_check" CHECK (("fast_agent_conversations"."privacy" = 'shared' AND "fast_agent_conversations"."private_owner_user_id" IS NULL) OR ("fast_agent_conversations"."privacy" = 'private' AND "fast_agent_conversations"."private_owner_user_id" IS NOT NULL AND "fast_agent_conversations"."private_owner_user_id" = "fast_agent_conversations"."user_id"));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_privacy_check" CHECK ("sessions"."privacy" in ('shared', 'private'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_private_owner_check" CHECK (("sessions"."privacy" = 'shared' AND "sessions"."private_owner_user_id" IS NULL) OR ("sessions"."privacy" = 'private' AND "sessions"."private_owner_user_id" IS NOT NULL AND "sessions"."private_owner_user_id" = "sessions"."owner_user_id"));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_privacy_check" CHECK ("tasks"."privacy" in ('shared', 'private'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_private_owner_check" CHECK (("tasks"."privacy" = 'shared' AND "tasks"."private_owner_user_id" IS NULL) OR ("tasks"."privacy" = 'private' AND "tasks"."private_owner_user_id" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION "prevent_session_privacy_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."privacy" IS DISTINCT FROM OLD."privacy" OR NEW."private_owner_user_id" IS DISTINCT FROM OLD."private_owner_user_id" THEN
    RAISE EXCEPTION 'session privacy and private owner are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "fast_agent_conversations_privacy_immutable" BEFORE UPDATE ON "fast_agent_conversations" FOR EACH ROW EXECUTE FUNCTION "prevent_session_privacy_change"();
--> statement-breakpoint
CREATE TRIGGER "sessions_privacy_immutable" BEFORE UPDATE ON "sessions" FOR EACH ROW EXECUTE FUNCTION "prevent_session_privacy_change"();
--> statement-breakpoint
CREATE TRIGGER "tasks_privacy_immutable" BEFORE UPDATE ON "tasks" FOR EACH ROW EXECUTE FUNCTION "prevent_session_privacy_change"();
