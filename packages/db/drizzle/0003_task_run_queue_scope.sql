ALTER TABLE "task_runs" ADD COLUMN "queue_scope" text;--> statement-breakpoint
CREATE INDEX "task_runs_queue_scope_idx" ON "task_runs" USING btree ("queue_scope");