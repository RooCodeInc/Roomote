ALTER TABLE "github_user_mappings" ADD COLUMN "token_refresh_claim" text;--> statement-breakpoint
ALTER TABLE "github_user_mappings" ADD COLUMN "token_refresh_claimed_at" timestamp;