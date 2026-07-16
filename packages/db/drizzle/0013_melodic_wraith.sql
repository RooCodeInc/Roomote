ALTER TABLE "environments" ADD COLUMN "is_verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "verification_task_id" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "verification_error" text;