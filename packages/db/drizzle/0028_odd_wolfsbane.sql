CREATE TABLE "model_provider_environment_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"created_by_user_id" text,
	"last_updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_provider_environment_variables" ADD CONSTRAINT "model_provider_environment_variables_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_environment_variables" ADD CONSTRAINT "model_provider_environment_variables_last_updated_by_user_id_users_id_fk" FOREIGN KEY ("last_updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_environment_variables_name_unique" ON "model_provider_environment_variables" USING btree ("name");--> statement-breakpoint
-- Keep the legacy rows for N-1 rollback. Model-provider values are dual-written
-- until the previous application release is no longer a supported rollback.
INSERT INTO "model_provider_environment_variables" (
	"name",
	"value",
	"created_by_user_id",
	"last_updated_by_user_id",
	"created_at",
	"updated_at"
)
SELECT
	"name",
	"value",
	"created_by_user_id",
	"last_updated_by_user_id",
	"created_at",
	"updated_at"
FROM "environment_variables"
WHERE "name" IN (
	'OPENROUTER_API_KEY',
	'AI_GATEWAY_API_KEY',
	'REQUESTY_API_KEY',
	'BASETEN_API_KEY',
	'TOGETHER_API_KEY',
	'OPENAI_API_KEY',
	'AZURE_API_KEY',
	'AZURE_RESOURCE_NAME',
	'AZURE_COGNITIVE_SERVICES_API_KEY',
	'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME',
	'ANTHROPIC_API_KEY',
	'MOONSHOT_API_KEY',
	'KIMI_API_KEY',
	'MINIMAX_API_KEY',
	'OPENCODE_API_KEY',
	'AWS_BEARER_TOKEN_BEDROCK',
	'AWS_REGION',
	'GEMINI_API_KEY',
	'GOOGLE_GENERATIVE_AI_API_KEY',
	'XAI_API_KEY',
	'ZAI_API_KEY',
	'ZAI_REGION',
	'ZAI_CODING_PLAN_API_KEY',
	'ZAI_CODING_PLAN_REGION',
	'OPENAI_COMPATIBLE_BASE_URL',
	'OPENAI_COMPATIBLE_API_KEY',
	'LITELLM_BASE_URL',
	'LITELLM_API_KEY',
	'OLLAMA_BASE_URL',
	'VLLM_BASE_URL',
	'VLLM_API_KEY',
	'R_MODEL_ENV_KEYS'
)
OR (
	"name" LIKE 'OPENAI_COMPATIBLE_%_BASE_URL'
	OR "name" LIKE 'OPENAI_COMPATIBLE_%_API_KEY'
	OR "name" LIKE 'OPENAI_COMPATIBLE_%_LABEL'
)
ON CONFLICT ("name") DO NOTHING;
