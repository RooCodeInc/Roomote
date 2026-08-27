CREATE TABLE "fast_agent_provider_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text,
	"message_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fast_agent_provider_messages_provider_check" CHECK ("fast_agent_provider_messages"."provider" in ('discord', 'teams'))
);
--> statement-breakpoint
ALTER TABLE "fast_agent_provider_messages" ADD CONSTRAINT "fast_agent_provider_messages_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fast_agent_provider_messages_route_unique" ON "fast_agent_provider_messages" USING btree ("provider","workspace_id","channel_id","message_id");--> statement-breakpoint
CREATE INDEX "fast_agent_provider_messages_conversation_idx" ON "fast_agent_provider_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "fast_agent_provider_messages_thread_idx" ON "fast_agent_provider_messages" USING btree ("provider","workspace_id","channel_id","thread_id");