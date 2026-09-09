CREATE TABLE "session_secret_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"secret_ref" uuid,
	"method" text,
	"destination" text,
	"outcome" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"label" text NOT NULL,
	"origin" text NOT NULL,
	"header_name" text NOT NULL,
	"header_prefix" text NOT NULL,
	"value" text,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_secrets" ADD CONSTRAINT "session_secrets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_secrets" ADD CONSTRAINT "session_secrets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_secrets_session_owner_idx" ON "session_secrets" USING btree ("session_id","owner_user_id");