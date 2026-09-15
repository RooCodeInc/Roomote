ALTER TABLE "session_secrets" DROP CONSTRAINT "session_secrets_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "session_secrets" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_secrets" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "session_secret_approvals" ADD COLUMN "lifetime_hours" integer;--> statement-breakpoint
ALTER TABLE "session_secrets" ADD CONSTRAINT "session_secrets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;