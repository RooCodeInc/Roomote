ALTER TABLE "instance_skills" ADD COLUMN "document" text;--> statement-breakpoint
ALTER TABLE "instance_skills" ADD COLUMN "marketplace_source" text;--> statement-breakpoint
ALTER TABLE "instance_skills" ADD COLUMN "marketplace_revision" text;--> statement-breakpoint
ALTER TABLE "instance_skills" ADD COLUMN "resources" jsonb DEFAULT '[]'::jsonb NOT NULL;