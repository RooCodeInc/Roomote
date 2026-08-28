UPDATE "users"
SET
  "metadata" = "metadata" || '{"communications_fast_mode_default": true}'::jsonb,
  "updated_at" = now()
WHERE NOT ("metadata" ? 'communications_fast_mode_default');
