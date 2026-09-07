ALTER TABLE "task_pull_requests" ADD COLUMN "mergeability_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "conflict_detected_at" timestamp;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "conflict_notification_claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD COLUMN "conflict_notified_at" timestamp;--> statement-breakpoint
CREATE INDEX "task_pull_requests_mergeability_lookup_idx" ON "task_pull_requests" USING btree ("source_control_provider","repository","status","created_by_roomote","pr_base_ref");