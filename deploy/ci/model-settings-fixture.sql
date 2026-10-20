-- Synthetic v1.15.1-shaped data, seeded before upgrading. Never use on a real
-- deployment. Keep explicit roles here: deriving the fixture from today's
-- descriptors would hide the missing-role regression.
INSERT INTO auth_users (id, name, email, email_verified)
VALUES ('model-settings-ci', 'Upgrade smoke', 'upgrade-smoke@example.test', true);
INSERT INTO users (id, name, email, image_url, entity, role, onboarding_completed_at)
VALUES ('model-settings-ci', 'Upgrade smoke', 'upgrade-smoke@example.test', '', '{}', 'admin', now());
INSERT INTO auth_sessions (id, user_id, token, expires_at)
VALUES ('model-settings-ci', 'model-settings-ci', :'session_token', now() + interval '1 day');

INSERT INTO deployment_settings (id) VALUES ('default') ON CONFLICT DO NOTHING;
UPDATE deployment_settings SET
  task_model_settings = '{"models":[{"id":"openrouter/openai/gpt-5.4","displayName":"GPT 5.4","family":"GPT"},{"id":"openrouter/z-ai/glm-5.2","displayName":"GLM 5.2","family":"GLM"}],"allowedModelIds":["openrouter/openai/gpt-5.4","openrouter/z-ai/glm-5.2"],"defaultModelId":"openrouter/openai/gpt-5.4"}',
  runtime_model_config = '{"roomoteModel":"openrouter/openai/gpt-5.4","roomoteModelReasoningEffort":"medium","roomoteSmallModel":"openrouter/z-ai/glm-5.2","roomoteSmallModelReasoningEffort":"low"}',
  model_fallback_config = '{"enabled":true,"roles":{"coding":{"modelId":"openrouter/z-ai/glm-5.2","reasoningEffort":"high"},"helper":{"modelId":"openrouter/openai/gpt-5.4","reasoningEffort":"medium"}}}'
WHERE id = 'default';

INSERT INTO user_task_model_mapping_presets (user_id, name, name_key, roles)
VALUES ('model-settings-ci', 'Upgrade legacy mapping', 'upgrade legacy mapping', '{
  "coding":{"modelId":"openrouter/openai/gpt-5.4","reasoningEffort":"high"},
  "orchestration":{"modelId":"openrouter/openai/gpt-5.4","reasoningEffort":"low"},
  "helper":{"modelId":"openrouter/z-ai/glm-5.2","reasoningEffort":"low"},
  "vision":{"modelId":"openrouter/z-ai/glm-5.2","reasoningEffort":null},
  "codeReview":{"modelId":"openrouter/openai/gpt-5.4","reasoningEffort":"high"},
  "explore":{"modelId":"openrouter/z-ai/glm-5.2","reasoningEffort":"low"},
  "planning":{"modelId":"openrouter/openai/gpt-5.4","reasoningEffort":"high"}
}');

CREATE TABLE deployment_ci_model_settings AS
SELECT task_model_settings, runtime_model_config, model_fallback_config,
  (SELECT roles FROM user_task_model_mapping_presets WHERE user_id = 'model-settings-ci') AS preset_roles
FROM deployment_settings WHERE id = 'default';
