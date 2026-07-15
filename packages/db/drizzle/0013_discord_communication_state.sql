CREATE TABLE "discord_gateway_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"resume_gateway_url" text,
	"sequence" bigint,
	"shard_count" integer,
	"last_connected_at" timestamp,
	"last_heartbeat_ack_at" timestamp,
	"disconnected_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_installation_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_installation_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"channel_type" integer NOT NULL,
	"parent_id" text,
	"position" integer,
	"permissions" text,
	"is_available" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" text NOT NULL,
	"guild_name" text,
	"application_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"installed_by_user_id" text,
	"default_channel_id" text,
	"default_channel_name" text,
	"default_channel_type" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_username" text,
	"discord_global_name" text,
	"discord_dm_channel_id" text,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_surface_check";--> statement-breakpoint
ALTER TABLE "discord_installation_channels" ADD CONSTRAINT "discord_installation_channels_discord_installation_id_discord_installations_id_fk" FOREIGN KEY ("discord_installation_id") REFERENCES "public"."discord_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_installations" ADD CONSTRAINT "discord_installations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_user_mappings" ADD CONSTRAINT "discord_user_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discord_installation_channels_installation_id_idx" ON "discord_installation_channels" USING btree ("discord_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_installation_channels_unique" ON "discord_installation_channels" USING btree ("discord_installation_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_installations_guild_id_unique" ON "discord_installations" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "discord_installations_active_idx" ON "discord_installations" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "discord_installations_default_channel_idx" ON "discord_installations" USING btree ("default_channel_id");--> statement-breakpoint
CREATE INDEX "discord_user_mappings_user_id_idx" ON "discord_user_mappings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discord_user_mappings_discord_user_id_unique" ON "discord_user_mappings" USING btree ("discord_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_runs_discord_source_event_unique" ON "task_runs" USING btree (("payload"->>'communicationSourceEventId')) WHERE "task_runs"."payload"->>'communicationProvider' = 'discord' AND "task_runs"."payload"->>'communicationSourceEventId' IS NOT NULL AND "task_runs"."canceled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_surface_check" CHECK ("tasks"."surface" in ('web', 'api', 'slack', 'teams', 'telegram', 'discord', 'linear', 'github', 'gitlab', 'gitea', 'ado', 'bitbucket', 'system'));