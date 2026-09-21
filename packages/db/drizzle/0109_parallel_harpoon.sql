ALTER TABLE "integration_tool_approval_requests" ADD COLUMN "shadow_evaluation" jsonb;--> statement-breakpoint
ALTER TABLE "integration_tool_policies" ADD COLUMN "instruction" text;