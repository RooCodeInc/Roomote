CREATE TABLE "telegram_managed_bot_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_id" uuid,
	"bot_id" text NOT NULL,
	"bot_username" text,
	"owner_telegram_user_id" text NOT NULL,
	"management_update_id" integer,
	"revoked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "telegram_managed_bot_candidate_unique" UNIQUE("bot_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_managed_bot_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"owner_telegram_user_id" text NOT NULL,
	"state" text NOT NULL,
	"bot_id" text,
	"bot_username" text,
	"bot_token" text,
	"webhook_secret" text NOT NULL,
	"ticket_hash" text,
	"ticket" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_managed_bot_state_check" CHECK ("telegram_managed_bot_pairings"."state" in ('pending', 'provisioning', 'ready', 'active', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "telegram_managed_bot_candidates" ADD CONSTRAINT "telegram_managed_bot_candidates_pairing_id_telegram_managed_bot_pairings_id_fk" FOREIGN KEY ("pairing_id") REFERENCES "public"."telegram_managed_bot_pairings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_managed_bot_pairings" ADD CONSTRAINT "telegram_managed_bot_pairings_session_id_fast_agent_conversations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_managed_bot_pairings" ADD CONSTRAINT "telegram_managed_bot_pairings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_managed_bot_pending_owner_unique" ON "telegram_managed_bot_pairings" USING btree ("owner_telegram_user_id") WHERE "telegram_managed_bot_pairings"."state" in ('pending', 'provisioning', 'ready');--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_managed_bot_session_unique" ON "telegram_managed_bot_pairings" USING btree ("session_id") WHERE "telegram_managed_bot_pairings"."state" <> 'revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_managed_bot_bot_unique" ON "telegram_managed_bot_pairings" USING btree ("bot_id");