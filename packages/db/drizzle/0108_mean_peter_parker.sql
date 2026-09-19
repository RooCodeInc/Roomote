CREATE TABLE "integration_tool_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"requester_user_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"native_request_id" text NOT NULL,
	"args_fingerprint" text NOT NULL,
	"args_summary" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp,
	"cancel_reason" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_tool_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"mode" text NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_tool_approval_requests" ADD CONSTRAINT "integration_tool_approval_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tool_approval_requests" ADD CONSTRAINT "integration_tool_approval_requests_requester_user_id_users_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tool_approval_requests" ADD CONSTRAINT "integration_tool_approval_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tool_policies" ADD CONSTRAINT "integration_tool_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_tool_approvals_session_requester_idx" ON "integration_tool_approval_requests" USING btree ("session_id","requester_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_tool_approvals_pending_native_idx" ON "integration_tool_approval_requests" USING btree ("session_id","native_request_id") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "integration_tool_policies_tool_idx" ON "integration_tool_policies" USING btree ("integration_id","tool_name");