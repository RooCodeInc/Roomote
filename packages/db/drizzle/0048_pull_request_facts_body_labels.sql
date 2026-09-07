ALTER TABLE "pull_request_facts" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "labels" jsonb;