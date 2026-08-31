CREATE TABLE "agentmail_conversation_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"inbox_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"source" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentmail_conversation_participants_conversation_user_unique" UNIQUE("conversation_id","user_id"),
	CONSTRAINT "agentmail_conversation_participants_thread_user_unique" UNIQUE("inbox_id","provider_thread_id","user_id"),
	CONSTRAINT "agentmail_conversation_participants_role_check" CHECK ("agentmail_conversation_participants"."role" in ('owner', 'participant')),
	CONSTRAINT "agentmail_conversation_participants_source_check" CHECK ("agentmail_conversation_participants"."source" in ('initiator', 'cc', 'link_code'))
);
--> statement-breakpoint
CREATE TABLE "agentmail_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"subject" text,
	"latest_inbound_message_id" text,
	"latest_inbound_at" timestamp,
	"latest_inbound_sender_email" text,
	"latest_inbound_user_id" text,
	"latest_outbound_message_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentmail_conversations_id_thread_unique" UNIQUE("id","inbox_id","provider_thread_id")
);
--> statement-breakpoint
CREATE TABLE "agentmail_inbound_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"webhook_event_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_timestamp" timestamp NOT NULL,
	"sender_email" text NOT NULL,
	"sender_user_id" text NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "agentmail_inbound_turns_webhook_event_unique" UNIQUE("webhook_event_id"),
	CONSTRAINT "agentmail_inbound_turns_state_check" CHECK ("agentmail_inbound_turns"."state" in ('pending', 'consumed'))
);
--> statement-breakpoint
CREATE TABLE "agentmail_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_address" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentmail_user_mappings_unique" UNIQUE("email_address"),
	CONSTRAINT "agentmail_user_mappings_source_check" CHECK ("agentmail_user_mappings"."source" in ('verified_match', 'link_code'))
);
--> statement-breakpoint
CREATE TABLE "agentmail_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" text NOT NULL,
	"event_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentmail_webhook_events_delivery_unique" UNIQUE("delivery_id"),
	CONSTRAINT "agentmail_webhook_events_state_check" CHECK ("agentmail_webhook_events"."state" in ('received', 'queued', 'processing', 'processed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_source_surface_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_surface_check";--> statement-breakpoint
ALTER TABLE "agentmail_conversation_participants" ADD CONSTRAINT "agentmail_conversation_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_conversation_participants" ADD CONSTRAINT "agentmail_conversation_participants_conversation_fk" FOREIGN KEY ("conversation_id","inbox_id","provider_thread_id") REFERENCES "public"."agentmail_conversations"("id","inbox_id","provider_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_conversations" ADD CONSTRAINT "agentmail_conversations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_conversations" ADD CONSTRAINT "agentmail_conversations_latest_inbound_user_id_users_id_fk" FOREIGN KEY ("latest_inbound_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_inbound_turns" ADD CONSTRAINT "agentmail_inbound_turns_conversation_id_agentmail_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agentmail_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_inbound_turns" ADD CONSTRAINT "agentmail_inbound_turns_webhook_event_id_agentmail_webhook_events_id_fk" FOREIGN KEY ("webhook_event_id") REFERENCES "public"."agentmail_webhook_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_inbound_turns" ADD CONSTRAINT "agentmail_inbound_turns_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentmail_user_mappings" ADD CONSTRAINT "agentmail_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agentmail_conversation_participants_user_idx" ON "agentmail_conversation_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agentmail_conversations_thread_idx" ON "agentmail_conversations" USING btree ("inbox_id","provider_thread_id");--> statement-breakpoint
CREATE INDEX "agentmail_conversations_owner_idx" ON "agentmail_conversations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "agentmail_inbound_turns_drain_idx" ON "agentmail_inbound_turns" USING btree ("conversation_id","state","provider_timestamp","provider_message_id");--> statement-breakpoint
CREATE INDEX "agentmail_user_mappings_user_id_idx" ON "agentmail_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agentmail_webhook_events_state_idx" ON "agentmail_webhook_events" USING btree ("state","received_at");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_source_surface_check" CHECK ("sessions"."source_surface" in ('web', 'api', 'slack', 'teams', 'telegram', 'discord', 'agentmail', 'linear', 'github', 'gitlab', 'gitea', 'ado', 'bitbucket', 'system', 'automation'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_surface_check" CHECK ("tasks"."surface" in ('web', 'api', 'slack', 'teams', 'telegram', 'discord', 'agentmail', 'linear', 'github', 'gitlab', 'gitea', 'ado', 'bitbucket', 'system'));