CREATE TABLE "pr_review_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_control_provider" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"review_head_sha" text NOT NULL,
	"cycle_id" text NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "pr_review_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp NOT NULL,
	"deferrals" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_event_deliveries_status_check" CHECK ("pr_review_event_deliveries"."status" in ('pending', 'processing', 'delivered', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "pr_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"source_control_provider" text NOT NULL,
	"repository" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_url" text,
	"event" jsonb NOT NULL,
	"batch_kind" text NOT NULL,
	"batch_id" text,
	"review_head_sha" text,
	"superseded" boolean DEFAULT false NOT NULL,
	"available_at" timestamp NOT NULL,
	"observed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pr_review_events_batch_kind_check" CHECK ("pr_review_events"."batch_kind" in ('human', 'roomote'))
);
--> statement-breakpoint
ALTER TABLE "pr_review_event_deliveries" ADD CONSTRAINT "pr_review_event_deliveries_event_id_pr_review_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."pr_review_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_event_deliveries" ADD CONSTRAINT "pr_review_event_deliveries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_cycles_source_unique" ON "pr_review_cycles" USING btree ("source_control_provider","repository","pr_number","review_head_sha","cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_event_deliveries_event_task_unique" ON "pr_review_event_deliveries" USING btree ("event_id","task_id");--> statement-breakpoint
CREATE INDEX "pr_review_event_deliveries_due_idx" ON "pr_review_event_deliveries" USING btree ("status","due_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_events_source_unique" ON "pr_review_events" USING btree ("source_control_provider","repository","pr_number","event_key");--> statement-breakpoint
CREATE INDEX "pr_review_events_pr_idx" ON "pr_review_events" USING btree ("source_control_provider","repository","pr_number");
