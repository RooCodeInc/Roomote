ALTER TABLE "tasks" ADD COLUMN "goal_objective" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_status" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_max_continuations" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_continuations_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_blocked_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_last_continuation_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_continuation_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_blocker_candidate_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_blocker_candidate_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "goal_blocker_last_continuation_used" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_status_check" CHECK ("tasks"."goal_status" IS NULL OR "tasks"."goal_status" in ('active', 'complete', 'blocked', 'budget_limited'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_continuations_check" CHECK ("tasks"."goal_continuations_used" >= 0 AND ("tasks"."goal_max_continuations" IS NULL OR "tasks"."goal_max_continuations" > 0));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_goal_blocker_candidate_count_check" CHECK ("tasks"."goal_blocker_candidate_count" >= 0);