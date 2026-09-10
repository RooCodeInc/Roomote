CREATE TABLE "source_control_connection_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"tool" jsonb,
	"provider" text,
	"repository_full_name" text,
	"environment_id" text,
	"capability" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"sync_attempt" jsonb,
	"completed_by_user_id" text,
	"continuation_event_key" text,
	"execution_started_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "source_control_connection_requests_continuation_event_key_unique" UNIQUE("continuation_event_key"),
	CONSTRAINT "source_control_connection_requests_status_check" CHECK ("source_control_connection_requests"."status" in ('pending', 'ready', 'continued', 'cancelled', 'expired', 'superseded')),
	CONSTRAINT "source_control_connection_requests_capability_check" CHECK ("source_control_connection_requests"."capability" in ('repository', 'source_control_tool')),
	CONSTRAINT "source_control_connection_requests_provider_check" CHECK ("source_control_connection_requests"."provider" is null or "source_control_connection_requests"."provider" in ('github', 'gitlab', 'gitea', 'ado', 'bitbucket'))
);
--> statement-breakpoint
ALTER TABLE "source_control_connection_requests" ADD CONSTRAINT "source_control_connection_requests_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_control_connection_requests" ADD CONSTRAINT "source_control_connection_requests_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_control_connection_requests" ADD CONSTRAINT "source_control_connection_requests_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_control_connection_requests_active_unique" ON "source_control_connection_requests" USING btree ("conversation_id") WHERE "source_control_connection_requests"."status" in ('pending', 'ready');--> statement-breakpoint
CREATE INDEX "source_control_connection_requests_pending_idx" ON "source_control_connection_requests" USING btree ("provider","status","expires_at");