CREATE TABLE "automations" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"schedule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"instructions" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_at" timestamp,
	"last_succeeded_at" timestamp,
	"last_failed_at" timestamp,
	"last_error" text,
	"scan_cursor" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_automation_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "background_automation_targets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "background_automations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "background_automation_runs" CASCADE;--> statement-breakpoint
DROP TABLE "background_automation_targets" CASCADE;--> statement-breakpoint
DROP TABLE "background_automations" CASCADE;--> statement-breakpoint
ALTER TABLE "automation_work_items" DROP CONSTRAINT "automation_work_items_background_automation_run_id_background_automation_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_initiator_automation_automations_key_fk" FOREIGN KEY ("initiator_automation") REFERENCES "public"."automations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_work_items" DROP COLUMN "background_automation_run_id";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "suggester_instructions";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "suggester_frequency";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "suggester_slack_channel_id";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "suggester_last_run_at";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "conflict_resolver_frequency";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "conflict_resolver_label";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "conflict_resolver_instructions";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "conflict_resolver_last_run_at";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "coach_frequency";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "coach_slack_channel_id";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "coach_instructions";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "coach_last_run_at";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "announcer_frequency";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "announcer_slack_channel_id";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "platform_issue_slack_channel_id";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "manager_stats_frequency";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "manager_stats_last_run_at";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "announcer_instructions";--> statement-breakpoint
ALTER TABLE "background_agent_settings" DROP COLUMN "announcer_last_run_at";