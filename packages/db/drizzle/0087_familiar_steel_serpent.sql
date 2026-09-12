CREATE TABLE "session_secret_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"label" text NOT NULL,
	"origin" text NOT NULL,
	"header_name" text NOT NULL,
	"header_prefix" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_secret_approvals" ADD CONSTRAINT "session_secret_approvals_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_secret_approvals" ADD CONSTRAINT "session_secret_approvals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_secret_approvals_session_owner_idx" ON "session_secret_approvals" USING btree ("session_id","owner_user_id");
