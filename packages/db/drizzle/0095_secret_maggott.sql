ALTER TABLE "service_credential_approvals" ADD COLUMN "visibility" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_credentials" ADD COLUMN "visibility" text DEFAULT 'owner' NOT NULL;
