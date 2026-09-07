CREATE TABLE "slack_fast_integration_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_quick_answer_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_channel" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"slack_message_ts" text NOT NULL,
	"integration_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"status" text NOT NULL,
	"result_preview" text,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_fast_integration_calls" ADD CONSTRAINT "slack_fast_integration_calls_slack_quick_answer_id_slack_quick_answers_id_fk" FOREIGN KEY ("slack_quick_answer_id") REFERENCES "public"."slack_quick_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_fast_integration_calls" ADD CONSTRAINT "slack_fast_integration_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_fast_integration_calls_session_idx" ON "slack_fast_integration_calls" USING btree ("slack_quick_answer_id","created_at");--> statement-breakpoint
CREATE INDEX "slack_fast_integration_calls_user_idx" ON "slack_fast_integration_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "slack_fast_integration_calls_status_idx" ON "slack_fast_integration_calls" USING btree ("status","created_at");