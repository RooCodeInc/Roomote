CREATE TABLE "agentmail_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_address" text NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"provider_message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentmail_suppressions_email_unique" UNIQUE("email_address"),
	CONSTRAINT "agentmail_suppressions_reason_check" CHECK ("agentmail_suppressions"."reason" in ('bounce', 'complaint', 'unsubscribe'))
);
--> statement-breakpoint
ALTER TABLE "agentmail_conversation_participants" DROP CONSTRAINT "agentmail_conversation_participants_source_check";--> statement-breakpoint
ALTER TABLE "agentmail_conversation_participants" ADD CONSTRAINT "agentmail_conversation_participants_source_check" CHECK ("agentmail_conversation_participants"."source" in ('initiator', 'cc', 'link_code', 'outbound'));