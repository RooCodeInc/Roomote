ALTER TABLE "session_egress_workloads" ADD COLUMN "proxy_last_sync_at" timestamp;--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD COLUMN "proxy_delivery_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD COLUMN "proxy_applied_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD COLUMN "proxy_applied_at" timestamp;