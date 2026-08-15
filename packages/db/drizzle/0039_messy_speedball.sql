ALTER TABLE "brain_memory_events" ADD COLUMN "run_completed_at" timestamp;--> statement-breakpoint
UPDATE "brain_memory_events" AS "event"
SET "run_completed_at" = "run"."completed_at"
FROM "task_runs" AS "run"
WHERE "run"."id" = "event"."run_id";--> statement-breakpoint
CREATE INDEX "brain_memory_events_active_priority_idx" ON "brain_memory_events" USING btree ("run_completed_at" DESC NULLS LAST,"run_id" DESC NULLS LAST) WHERE "brain_memory_events"."status" IN ('pending', 'processing');--> statement-breakpoint
DROP INDEX "brain_memory_events_status_created_idx";
