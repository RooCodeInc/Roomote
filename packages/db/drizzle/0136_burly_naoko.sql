ALTER TABLE "vulnerability_findings" ADD COLUMN "evidence_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "vulnerability_findings" ADD COLUMN "policy_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "vulnerability_inventories" ADD COLUMN "gap_metadata" jsonb;