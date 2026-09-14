ALTER TABLE "session_egress_workloads" ADD COLUMN "admission_mode" text DEFAULT 'external_mtls' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD COLUMN "proxy_capability_hash" text;--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD COLUMN "proxy_capability_expires_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "session_egress_workloads_proxy_capability_unique" ON "session_egress_workloads" USING btree ("proxy_capability_hash");--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD CONSTRAINT "session_egress_workloads_admission_mode_check" CHECK ("session_egress_workloads"."admission_mode" in ('external_mtls', 'authenticated_proxy'));