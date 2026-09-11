CREATE TABLE "session_egress_audit" (
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
CREATE TABLE "session_egress_revocations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "session_egress_revocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"workload_id" uuid,
	"secret_ref" uuid,
	"generation" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_egress_substitutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workload_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_egress_workloads" (
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
	CONSTRAINT "session_egress_workloads_status_check" CHECK ("session_egress_workloads"."status" in ('active', 'terminated'))
);
--> statement-breakpoint
ALTER TABLE "session_secret_approvals" ADD COLUMN "allowed_methods" text[] DEFAULT '{GET,HEAD}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "session_secrets" ADD COLUMN "allowed_methods" text[] DEFAULT '{GET,HEAD}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "session_egress_substitutes" ADD CONSTRAINT "session_egress_substitutes_workload_id_session_egress_workloads_id_fk" FOREIGN KEY ("workload_id") REFERENCES "public"."session_egress_workloads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_egress_substitutes" ADD CONSTRAINT "session_egress_substitutes_secret_id_session_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."session_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD CONSTRAINT "session_egress_workloads_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD CONSTRAINT "session_egress_workloads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_egress_workloads" ADD CONSTRAINT "session_egress_workloads_task_run_id_task_runs_id_fk" FOREIGN KEY ("task_run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_egress_substitutes_token_hash_unique" ON "session_egress_substitutes" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "session_egress_substitutes_workload_secret_generation_unique" ON "session_egress_substitutes" USING btree ("workload_id","secret_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "session_egress_workloads_active_run_unique" ON "session_egress_workloads" USING btree ("task_run_id") WHERE "session_egress_workloads"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "session_egress_workloads_active_connector_unique" ON "session_egress_workloads" USING btree ("connector_identity") WHERE "session_egress_workloads"."status" = 'active';--> statement-breakpoint
CREATE INDEX "session_egress_workloads_session_idx" ON "session_egress_workloads" USING btree ("session_id");