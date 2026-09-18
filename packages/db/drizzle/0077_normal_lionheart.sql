CREATE TABLE "session_wakeups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"prompt_signature" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"report_policy" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"max_runs" integer,
	"until" timestamp,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp,
	"last_fired_at" timestamp,
	"last_error" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_wakeups_status_check" CHECK ("session_wakeups"."status" in ('active', 'completed', 'cancelled', 'failed')),
	CONSTRAINT "session_wakeups_report_policy_check" CHECK ("session_wakeups"."report_policy" in ('always', 'only_when_notable'))
);
--> statement-breakpoint
ALTER TABLE "session_wakeups" ADD CONSTRAINT "session_wakeups_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_wakeups" ADD CONSTRAINT "session_wakeups_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_wakeups_due_idx" ON "session_wakeups" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "session_wakeups_conversation_idx" ON "session_wakeups" USING btree ("conversation_id","status");