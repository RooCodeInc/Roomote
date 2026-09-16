ALTER TABLE "service_credential_approvals" ADD COLUMN "visibility" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_credentials" ADD COLUMN "visibility" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_credential_approvals" ALTER COLUMN "visibility" SET DEFAULT 'deployment';--> statement-breakpoint
ALTER TABLE "service_credentials" ALTER COLUMN "visibility" SET DEFAULT 'deployment';
