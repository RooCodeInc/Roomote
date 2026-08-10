ALTER TABLE "pr_review_notification_deliveries" ADD COLUMN "action_nonce" text;--> statement-breakpoint
ALTER TABLE "pr_review_notification_deliveries" ADD COLUMN "action_handled_at" timestamp;