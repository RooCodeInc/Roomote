CREATE TABLE "brain_memory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"agent_summary" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "brain_memory_events_run_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "brain_sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collector_id" text NOT NULL,
	"watermark" timestamp,
	"backfill_cursor" text,
	"backfill_completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "brain_sync_state_collector_id_unique" UNIQUE("collector_id")
);
--> statement-breakpoint
ALTER TABLE "brain_memory_events" ADD CONSTRAINT "brain_memory_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brain_memory_events_status_created_idx" ON "brain_memory_events" USING btree ("status","created_at");