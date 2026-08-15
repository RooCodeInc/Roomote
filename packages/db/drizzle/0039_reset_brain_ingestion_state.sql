-- Existing gbrain corpora may have been rebuilt while Roomote retained the
-- old collector checkpoints. Force one idempotent replay on upgrade; future
-- corpus recreations reset this state when OAuth clients are reprovisioned.
WITH reset_sync_state AS (
	DELETE FROM "brain_sync_state"
	RETURNING 1
)
UPDATE "brain_memory_events"
SET
	"status" = 'pending',
	"attempts" = 0,
	"last_error" = NULL,
	"processed_at" = NULL,
	"updated_at" = now()
WHERE "run_id" IN (
	SELECT "id" FROM "task_runs" WHERE "status" = 'completed'
);
