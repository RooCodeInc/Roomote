-- Forward repair for development databases that already applied the original
-- 0011/0012 migrations. Fresh v0.6 upgrades keep the legacy objects in place,
-- so every operation here is intentionally idempotent.
DO $$
BEGIN
  IF to_regclass('public.task_inference_usage_events') IS NULL
    AND to_regclass('public.llm_usage_events') IS NOT NULL THEN
    ALTER TABLE "llm_usage_events" RENAME TO "task_inference_usage_events";
  END IF;
END
$$;--> statement-breakpoint

ALTER TABLE "environments" ALTER COLUMN "is_verified" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN IF NOT EXISTS "style_guidance" text;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN IF NOT EXISTS "slack_summon_emoji" text;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN IF NOT EXISTS "slack_ack_emoji" text DEFAULT 'eyes' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_settings" ADD COLUMN IF NOT EXISTS "slack_completion_emoji" text DEFAULT 'white_check_mark' NOT NULL;--> statement-breakpoint

DO $$
DECLARE
  names record;
BEGIN
  FOR names IN
    SELECT *
    FROM (
      VALUES
        ('llm_usage_events_session_message_unique', 'task_inference_usage_events_session_message_unique'),
        ('llm_usage_events_event_key_unique', 'task_inference_usage_events_event_key_unique'),
        ('llm_usage_events_task_id_idx', 'task_inference_usage_events_task_id_idx'),
        ('llm_usage_events_run_id_idx', 'task_inference_usage_events_run_id_idx'),
        ('llm_usage_events_user_id_idx', 'task_inference_usage_events_user_id_idx'),
        ('llm_usage_events_environment_id_idx', 'task_inference_usage_events_environment_id_idx'),
        ('llm_usage_events_provider_model_idx', 'task_inference_usage_events_provider_model_idx'),
        ('llm_usage_events_created_at_idx', 'task_inference_usage_events_created_at_idx')
    ) AS index_names(old_name, new_name)
  LOOP
    IF to_regclass(format('public.%I', names.old_name)) IS NOT NULL
      AND to_regclass(format('public.%I', names.new_name)) IS NULL THEN
      EXECUTE format(
        'ALTER INDEX public.%I RENAME TO %I',
        names.old_name,
        names.new_name
      );
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint

DO $$
DECLARE
  names record;
BEGIN
  FOR names IN
    SELECT *
    FROM (
      VALUES
        ('llm_usage_events_task_id_tasks_id_fk', 'task_inference_usage_events_task_id_tasks_id_fk'),
        ('llm_usage_events_run_id_task_runs_id_fk', 'task_inference_usage_events_run_id_task_runs_id_fk'),
        ('llm_usage_events_user_id_users_id_fk', 'task_inference_usage_events_user_id_users_id_fk'),
        ('llm_usage_events_environment_id_environments_id_fk', 'task_inference_usage_events_environment_id_environments_id_fk')
    ) AS constraint_names(old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.task_inference_usage_events'::regclass
        AND conname = names.old_name
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.task_inference_usage_events'::regclass
        AND conname = names.new_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.task_inference_usage_events RENAME CONSTRAINT %I TO %I',
        names.old_name,
        names.new_name
      );
    END IF;
  END LOOP;
END
$$;
