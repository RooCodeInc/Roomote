ALTER TABLE "sessions" ADD COLUMN "manual_status_set_at" timestamp;--> statement-breakpoint
UPDATE "sessions"
SET "manual_status_set_at" = "updated_at"
WHERE "manual_status" IS NOT NULL;
