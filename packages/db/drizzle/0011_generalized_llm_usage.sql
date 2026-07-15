ALTER TABLE "task_inference_usage_events" RENAME TO "llm_usage_events";--> statement-breakpoint
ALTER TABLE "llm_usage_events" RENAME CONSTRAINT "task_inference_usage_events_task_id_tasks_id_fk" TO "llm_usage_events_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "llm_usage_events" RENAME CONSTRAINT "task_inference_usage_events_run_id_task_runs_id_fk" TO "llm_usage_events_run_id_task_runs_id_fk";--> statement-breakpoint
DROP INDEX "task_inference_usage_events_session_message_unique";--> statement-breakpoint
DROP INDEX "task_inference_usage_events_task_id_idx";--> statement-breakpoint
DROP INDEX "task_inference_usage_events_run_id_idx";--> statement-breakpoint
DROP INDEX "task_inference_usage_events_created_at_idx";--> statement-breakpoint
ALTER TABLE "llm_usage_events" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ALTER COLUMN "harness_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "usage_type" text DEFAULT 'inference' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "event_key" text;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD COLUMN "pricing_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_events_session_message_unique" ON "llm_usage_events" USING btree ("harness_session_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_events_event_key_unique" ON "llm_usage_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "llm_usage_events_task_id_idx" ON "llm_usage_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "llm_usage_events_run_id_idx" ON "llm_usage_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_usage_events_user_id_idx" ON "llm_usage_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "llm_usage_events_environment_id_idx" ON "llm_usage_events" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "llm_usage_events_provider_model_idx" ON "llm_usage_events" USING btree ("provider_id","model_id");--> statement-breakpoint
CREATE INDEX "llm_usage_events_created_at_idx" ON "llm_usage_events" USING btree ("created_at");
