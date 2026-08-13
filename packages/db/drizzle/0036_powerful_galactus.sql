ALTER TABLE "pr_review_events" ADD COLUMN "sealed_at" timestamp;
--> statement-breakpoint
UPDATE "pr_review_events" AS e
SET "sealed_at" = now()
WHERE e."event" ? 'automatedAuthorId'
  AND EXISTS (
    SELECT 1
    FROM "pr_review_event_deliveries" AS d
    WHERE d."event_id" = e."id"
      AND d."status" <> 'pending'
  );
