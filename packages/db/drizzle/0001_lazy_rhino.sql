ALTER TABLE "environments" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "declarative_source" text;