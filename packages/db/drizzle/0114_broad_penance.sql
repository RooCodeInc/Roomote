CREATE TABLE "integration_tool_auto_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"task_id" text,
	"integration_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args_summary" jsonb NOT NULL,
	"evaluation" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_tool_auto_evaluations" ADD CONSTRAINT "integration_tool_auto_evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tool_auto_evaluations" ADD CONSTRAINT "integration_tool_auto_evaluations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_tool_auto_evaluations_created_at_idx" ON "integration_tool_auto_evaluations" USING btree ("created_at" DESC NULLS LAST);