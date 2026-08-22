ALTER TABLE "pull_request_facts" ADD COLUMN "changed_files" jsonb;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "changed_file_count" integer;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "files_capped" boolean;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "reviews_capped" boolean;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "additions" integer;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "deletions" integer;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "reviews" jsonb;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "enriched_at" timestamp;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "enriched_for_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "pull_request_facts" ADD COLUMN "enrichment_failed_at" timestamp;