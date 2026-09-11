CREATE TABLE "fast_agent_personalization_snapshots" (
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text,
	"instructions" text NOT NULL,
	"learn_from_conversations" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fast_agent_personalization_snapshots_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "fast_agent_personalization_snapshots" ADD CONSTRAINT "fast_agent_personalization_snapshots_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fast_agent_personalization_snapshots" ADD CONSTRAINT "fast_agent_personalization_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;