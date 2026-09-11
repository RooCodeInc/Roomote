ALTER TABLE "sessions" ADD COLUMN "parent_session_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_parent_owner_side_chat_unique" ON "sessions" USING btree ("parent_session_id","owner_user_id") WHERE "sessions"."parent_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_parent_session_id_idx" ON "sessions" USING btree ("parent_session_id");