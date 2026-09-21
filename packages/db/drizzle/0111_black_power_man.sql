CREATE TABLE "integration_tool_session_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"integration_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"mode" text NOT NULL,
	"set_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_tool_session_overrides" ADD CONSTRAINT "integration_tool_session_overrides_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tool_session_overrides" ADD CONSTRAINT "integration_tool_session_overrides_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_tool_session_overrides_tool_idx" ON "integration_tool_session_overrides" USING btree ("session_id","integration_id","tool_name");