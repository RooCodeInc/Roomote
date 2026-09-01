CREATE TABLE "cloud_inference_usage_outbox" (
	"usage_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model_id" text,
	"usage_type" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"latency_ms" bigint,
	"outcome" text NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"credential_owner" text NOT NULL,
	"estimated_cost_micro_usd" bigint,
	"estimate_pricing_version" text,
	"provider_reported_cost_micro_usd" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cloud_inference_usage_outbox_pending_idx" ON "cloud_inference_usage_outbox" USING btree ("status","created_at");