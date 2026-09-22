ALTER TABLE "integration_tool_approval_requests" ADD COLUMN "auto_evaluation" jsonb;--> statement-breakpoint
ALTER TABLE "integration_tool_policies" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_tool_user_policies" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;