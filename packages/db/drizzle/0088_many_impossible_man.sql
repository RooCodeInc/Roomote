CREATE TABLE "session_goals" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"objective" text NOT NULL,
	"status" text NOT NULL,
	"max_continuations" integer NOT NULL,
	"continuations_used" integer DEFAULT 0 NOT NULL,
	"blocked_reason" text,
	"completed_at" timestamp,
	"last_continuation_id" text NOT NULL,
	"continuation_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"generation_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"blocker_candidate_reason" text,
	"blocker_candidate_count" integer DEFAULT 0 NOT NULL,
	"blocker_last_continuation_used" integer,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_goals_status_check" CHECK ("session_goals"."status" in ('active', 'complete', 'blocked', 'budget_limited', 'canceled')),
	CONSTRAINT "session_goals_continuations_check" CHECK ("session_goals"."continuations_used" >= 0 AND "session_goals"."max_continuations" > 0),
	CONSTRAINT "session_goals_blocker_candidate_count_check" CHECK ("session_goals"."blocker_candidate_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_goal_status_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_goal_continuations_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_goal_blocker_candidate_count_check";--> statement-breakpoint
ALTER TABLE "session_goals" ADD CONSTRAINT "session_goals_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_goals" ADD CONSTRAINT "session_goals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_objective";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_status";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_max_continuations";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_continuations_used";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_blocked_reason";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_completed_at";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_last_continuation_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_continuation_ids";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_generation_ids";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_blocker_candidate_reason";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_blocker_candidate_count";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "goal_blocker_last_continuation_used";