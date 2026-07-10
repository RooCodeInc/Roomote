ALTER TABLE "environment_variables" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "environment_variables" ALTER COLUMN "last_updated_by_user_id" DROP NOT NULL;