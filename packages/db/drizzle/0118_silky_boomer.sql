CREATE TABLE "session_status_judgments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"source_event_id" text NOT NULL,
	"generation" integer NOT NULL,
	"source_kind" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"confidence" real,
	"probabilities" jsonb,
	"model" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp,
	"settled_at" timestamp,
	"judged_at" timestamp,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_status_judgments_source_kind_check" CHECK ("session_status_judgments"."source_kind" in ('fast_turn', 'task_terminal')),
	CONSTRAINT "session_status_judgments_state_check" CHECK ("session_status_judgments"."state" in ('awaiting_settlement', 'pending', 'processing', 'applied', 'ignored', 'failed', 'stale')),
	CONSTRAINT "session_status_judgments_outcome_check" CHECK ("session_status_judgments"."outcome" IS NULL OR "session_status_judgments"."outcome" in ('open', 'done', 'blocked', 'needs_input', 'unclear')),
	CONSTRAINT "session_status_judgments_confidence_check" CHECK ("session_status_judgments"."confidence" IS NULL OR ("session_status_judgments"."confidence" >= 0 AND "session_status_judgments"."confidence" <= 1)),
	CONSTRAINT "session_status_judgments_attempts_check" CHECK ("session_status_judgments"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "session_status_judgments" ADD CONSTRAINT "session_status_judgments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_status_judgments_session_event_unique" ON "session_status_judgments" USING btree ("session_id","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_status_judgments_session_generation_unique" ON "session_status_judgments" USING btree ("session_id","generation");--> statement-breakpoint
CREATE INDEX "session_status_judgments_pending_idx" ON "session_status_judgments" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "session_status_judgments_session_generation_idx" ON "session_status_judgments" USING btree ("session_id","generation" DESC NULLS LAST);