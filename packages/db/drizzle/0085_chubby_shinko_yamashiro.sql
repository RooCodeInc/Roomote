CREATE TABLE "automation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_key" text,
	"custom_automation_id" uuid,
	"source_task_id" text,
	"user_id" text,
	"automation_name" text NOT NULL,
	"content" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"dedupe_key" text NOT NULL,
	"accepted_at" timestamp,
	"ignored_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_automations" ADD COLUMN "result_priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "result_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "result_ignored_at" timestamp;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "result_automation_name" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "result_priority" text;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "result_user_id" text;--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_automation_key_automations_key_fk" FOREIGN KEY ("automation_key") REFERENCES "public"."automations"("key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_custom_automation_id_custom_automations_id_fk" FOREIGN KEY ("custom_automation_id") REFERENCES "public"."custom_automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_results_dedupe_key_unique_idx" ON "automation_results" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "automation_results_inbox_idx" ON "automation_results" USING btree ("priority","created_at");--> statement-breakpoint
CREATE INDEX "automation_results_user_id_idx" ON "automation_results" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "automation_results_source_task_id_idx" ON "automation_results" USING btree ("source_task_id");--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_result_user_id_users_id_fk" FOREIGN KEY ("result_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;