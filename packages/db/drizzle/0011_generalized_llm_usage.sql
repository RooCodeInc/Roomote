ALTER TABLE "task_inference_usage_events" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ALTER COLUMN "harness_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD COLUMN "usage_type" text DEFAULT 'inference' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD COLUMN "event_key" text;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD COLUMN "pricing_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD CONSTRAINT "task_inference_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_inference_usage_events" ADD CONSTRAINT "task_inference_usage_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_inference_usage_events_event_key_unique" ON "task_inference_usage_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "task_inference_usage_events_user_id_idx" ON "task_inference_usage_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_inference_usage_events_environment_id_idx" ON "task_inference_usage_events" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "task_inference_usage_events_provider_model_idx" ON "task_inference_usage_events" USING btree ("provider_id","model_id");
