CREATE TABLE "fast_agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"turn_seq" integer NOT NULL,
	"ts" bigint NOT NULL,
	"event_type" text NOT NULL,
	"role" text,
	"content_blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"native_session_id" text,
	"native_message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fast_agent_messages" ADD CONSTRAINT "fast_agent_messages_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fast_agent_messages_conversation_event_unique" ON "fast_agent_messages" USING btree ("conversation_id","event_id");--> statement-breakpoint
CREATE INDEX "fast_agent_messages_conversation_order_idx" ON "fast_agent_messages" USING btree ("conversation_id","ts","turn_seq");