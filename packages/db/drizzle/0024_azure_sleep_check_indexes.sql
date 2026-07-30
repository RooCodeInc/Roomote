-- Replace the 6-vendor sleep-check partial indexes on task_runs with
-- azure-inclusive *_v2 versions. Replacements are created BEFORE the
-- originals are dropped so sleep-check queries keep index coverage
-- throughout. Each plain CREATE INDEX takes a brief write lock on
-- task_runs; CREATE INDEX CONCURRENTLY is not used because drizzle wraps
-- migrations in a transaction (CONCURRENTLY cannot run inside one).
CREATE INDEX "task_runs_sleep_check_due_v2_idx" ON "task_runs" USING btree ("sleep_at","created_at","vendor") WHERE "task_runs"."status" IN ('running', 'idle') AND "task_runs"."machine_id" IS NOT NULL AND "task_runs"."sleep_at" IS NOT NULL AND "task_runs"."sleep_requested_at" IS NULL AND "task_runs"."snapshot_id" IS NULL AND "task_runs"."snapshot_requested_at" IS NULL AND "task_runs"."vendor" IN ('modal', 'daytona', 'e2b', 'docker', 'blaxel', 'roomote', 'azure');--> statement-breakpoint
DROP INDEX "task_runs_sleep_check_due_idx";--> statement-breakpoint
CREATE INDEX "task_runs_sleep_check_stale_worker_v2_idx" ON "task_runs" USING btree ("worker_heartbeat_at","created_at","vendor") WHERE "task_runs"."status" IN ('running', 'idle') AND "task_runs"."machine_id" IS NOT NULL AND "task_runs"."worker_heartbeat_at" IS NOT NULL AND "task_runs"."sleep_requested_at" IS NULL AND "task_runs"."snapshot_id" IS NULL AND "task_runs"."snapshot_requested_at" IS NULL AND "task_runs"."vendor" IN ('modal', 'daytona', 'e2b', 'docker', 'blaxel', 'roomote', 'azure');--> statement-breakpoint
DROP INDEX "task_runs_sleep_check_stale_worker_idx";--> statement-breakpoint
CREATE INDEX "task_runs_sleep_check_active_v2_idx" ON "task_runs" USING btree ("vendor","created_at" DESC NULLS LAST) WHERE "task_runs"."status" IN ('running', 'idle') AND "task_runs"."machine_id" IS NOT NULL AND "task_runs"."sleep_requested_at" IS NULL AND "task_runs"."snapshot_id" IS NULL AND "task_runs"."snapshot_requested_at" IS NULL AND "task_runs"."vendor" IN ('modal', 'daytona', 'e2b', 'docker', 'blaxel', 'roomote', 'azure');--> statement-breakpoint
DROP INDEX "task_runs_sleep_check_active_idx";
