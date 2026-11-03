ALTER TABLE "tasks" ADD COLUMN "inference_request_limit" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "inference_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "safety_stopped_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "safety_stop_reason" text;