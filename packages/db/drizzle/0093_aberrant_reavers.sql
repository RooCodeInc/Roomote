CREATE TABLE "credential_egress_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid,
	"workload_id" uuid,
	"session_id" uuid,
	"actor_user_id" text,
	"secret_ref" uuid,
	"phase" text NOT NULL,
	"method" text,
	"destination" text,
	"decision" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_egress_revocations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credential_egress_revocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"workload_id" uuid,
	"secret_ref" uuid,
	"generation" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_egress_substitutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workload_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_egress_workloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"task_run_id" integer NOT NULL,
	"provider" text NOT NULL,
	"connector_identity" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"terminated_at" timestamp,
	"termination_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credential_egress_workloads_status_check" CHECK ("credential_egress_workloads"."status" in ('active', 'terminated'))
);
--> statement-breakpoint
CREATE TABLE "service_credential_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"label" text NOT NULL,
	"origin" text NOT NULL,
	"header_name" text NOT NULL,
	"header_prefix" text NOT NULL,
	"allowed_methods" text[] DEFAULT '{GET,HEAD}'::text[] NOT NULL,
	"lifetime_hours" integer,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_credential_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"secret_ref" uuid,
	"method" text,
	"destination" text,
	"outcome" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"owner_user_id" text NOT NULL,
	"label" text NOT NULL,
	"origin" text NOT NULL,
	"header_name" text NOT NULL,
	"header_prefix" text NOT NULL,
	"allowed_methods" text[] DEFAULT '{GET,HEAD}'::text[] NOT NULL,
	"value" text,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "session_egress_audit" CASCADE;--> statement-breakpoint
DROP TABLE "session_egress_revocations" CASCADE;--> statement-breakpoint
DROP TABLE "session_egress_substitutes" CASCADE;--> statement-breakpoint
DROP TABLE "session_egress_workloads" CASCADE;--> statement-breakpoint
DROP TABLE "session_secret_approvals" CASCADE;--> statement-breakpoint
DROP TABLE "session_secret_audit" CASCADE;--> statement-breakpoint
DROP TABLE "session_secrets" CASCADE;--> statement-breakpoint
ALTER TABLE "credential_egress_substitutes" ADD CONSTRAINT "credential_egress_substitutes_workload_id_credential_egress_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."credential_egress_workloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_egress_substitutes" ADD CONSTRAINT "credential_egress_substitutes_secret_id_service_credentials_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."service_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_egress_workloads" ADD CONSTRAINT "credential_egress_workloads_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_egress_workloads" ADD CONSTRAINT "credential_egress_workloads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_egress_workloads" ADD CONSTRAINT "credential_egress_workloads_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_credential_approvals" ADD CONSTRAINT "service_credential_approvals_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_credential_approvals" ADD CONSTRAINT "service_credential_approvals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_egress_substitutes_token_hash_unique" ON "credential_egress_substitutes" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_egress_substitutes_workload_secret_generation_unique" ON "credential_egress_substitutes" USING btree ("workload_id","secret_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_egress_workloads_active_run_unique" ON "credential_egress_workloads" USING btree ("task_run_id") WHERE "credential_egress_workloads"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "credential_egress_workloads_active_connector_unique" ON "credential_egress_workloads" USING btree ("connector_identity") WHERE "credential_egress_workloads"."status" = 'active';--> statement-breakpoint
CREATE INDEX "credential_egress_workloads_session_idx" ON "credential_egress_workloads" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "service_credential_approvals_session_owner_idx" ON "service_credential_approvals" USING btree ("session_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "service_credentials_session_owner_idx" ON "service_credentials" USING btree ("session_id","owner_user_id");