ALTER TABLE "automation_results" ADD COLUMN "source_run_id" integer;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "result_kind" text DEFAULT 'outcome' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "headline" text;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "decision_context" text;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "selected_reference_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "preparation_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "preparation_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "preparation_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "prepared_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "preparation_error_code" text;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "superseded_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_source_run_id_task_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."task_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_results_source_run_id_idx" ON "automation_results" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "automation_results_source_session_id_idx" ON "automation_results" USING btree ("source_session_id");--> statement-breakpoint
CREATE INDEX "automation_results_preparation_status_created_at_idx" ON "automation_results" USING btree ("preparation_status","created_at");--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_result_kind_check" CHECK ("automation_results"."result_kind" in ('outcome', 'input_request'));--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_preparation_status_check" CHECK ("automation_results"."preparation_status" in ('pending', 'ready', 'failed'));