ALTER TABLE "task_runs" ADD COLUMN "wait_until" timestamp;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "wait_reason" text;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "wait_resumed_at" timestamp;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "wait_resume_run_id" integer;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_wait_resume_run_id_task_runs_id_fk" FOREIGN KEY ("wait_resume_run_id") REFERENCES "public"."task_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_runs_wait_until_idx" ON "task_runs" USING btree ("wait_until");