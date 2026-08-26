DROP INDEX "pr_review_notification_units_identity_unique";--> statement-breakpoint
ALTER TABLE "pr_review_notification_units" ADD COLUMN "head_identity_key" text;--> statement-breakpoint
UPDATE "pr_review_notification_units" SET "head_identity_key" = coalesce("head_sha", '');--> statement-breakpoint
ALTER TABLE "pr_review_notification_units" ALTER COLUMN "head_identity_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_notification_units_identity_unique" ON "pr_review_notification_units" USING btree ("source_control_provider","repository_identity_key","pr_number","head_identity_key","episode_kind","episode_id");
