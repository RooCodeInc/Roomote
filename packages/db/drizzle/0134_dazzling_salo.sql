CREATE TABLE "vulnerability_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" uuid NOT NULL,
	"package_key" text NOT NULL,
	"revision" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"dispatched_fingerprint" text,
	"state" text DEFAULT 'investigating' NOT NULL,
	"task_id" text,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vulnerability_inventories" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"fingerprint" text NOT NULL,
	"dependencies" jsonb NOT NULL,
	"gaps" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vulnerability_watch_state" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" jsonb,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vulnerability_findings" ADD CONSTRAINT "vulnerability_findings_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_findings" ADD CONSTRAINT "vulnerability_findings_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vulnerability_inventories" ADD CONSTRAINT "vulnerability_inventories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vulnerability_findings_repository_idx" ON "vulnerability_findings" USING btree ("repository_id");