UPDATE "users"
SET
  "metadata" = "metadata" || '{"communications_fast_mode_default": true}'::jsonb,
  "updated_at" = now()
WHERE "metadata" -> 'communications_fast_mode_default' IS DISTINCT FROM 'true'::jsonb;
