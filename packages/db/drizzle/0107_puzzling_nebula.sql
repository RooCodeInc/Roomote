CREATE TABLE "tool_call_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"requester_user_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args_fingerprint" text NOT NULL,
	"args_summary" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_call_approvals" ADD CONSTRAINT "tool_call_approvals_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_approvals" ADD CONSTRAINT "tool_call_approvals_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_approvals" ADD CONSTRAINT "tool_call_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_call_approvals_session_requester_idx" ON "tool_call_approvals" USING btree ("session_id","requester_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_call_approvals_pending_call_idx" ON "tool_call_approvals" USING btree ("session_id","args_fingerprint") WHERE status = 'pending';