ALTER TABLE "sessions" ADD COLUMN "inactivity_due_at" timestamp;--> statement-breakpoint
UPDATE "sessions" AS session
SET "inactivity_due_at" = (
  SELECT to_timestamp(fam.ts / 1000.0) + interval '4 days'
  FROM "fast_agent_messages" AS fam
  WHERE fam.conversation_id = session.fast_conversation_id
    AND fam.role = 'user'
    AND (
      fam.metadata ->> 'visibleInTranscript' = 'true'
      OR (
        fam.metadata ->> 'visibleInTranscript' IS NULL
        AND fam.event_type <> 'roomote_runtime.user_prompt'
      )
  )
  ORDER BY fam.ts DESC
  LIMIT 1
)
WHERE session.visibility = 'visible';--> statement-breakpoint
CREATE INDEX "sessions_inactivity_due_idx" ON "sessions" USING btree ("visibility","inactivity_due_at","id") WHERE "sessions"."inactivity_due_at" IS NOT NULL AND "sessions"."manual_status" IS NULL;
