CREATE TABLE "fast_agent_parent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"parent" jsonb NOT NULL,
	"event" jsonb NOT NULL,
	"retry_task_start_run_id" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp,
	"discarded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fast_agent_parent_events_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
ALTER TABLE "fast_agent_parent_events" ADD CONSTRAINT "fast_agent_parent_events_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fast_agent_parent_events" ADD CONSTRAINT "fast_agent_parent_events_retry_task_start_run_id_task_runs_id_fk" FOREIGN KEY ("retry_task_start_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fast_agent_parent_events_pending_idx" ON "fast_agent_parent_events" USING btree ("conversation_id","delivered_at","discarded_at","created_at");--> statement-breakpoint
CREATE INDEX "fast_agent_parent_events_retry_run_idx" ON "fast_agent_parent_events" USING btree ("retry_task_start_run_id");