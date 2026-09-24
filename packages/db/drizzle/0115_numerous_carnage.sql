CREATE TABLE "user_task_model_mapping_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"roles" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_task_model_mapping_presets" ADD CONSTRAINT "user_task_model_mapping_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_task_model_mapping_presets_owner_name_unique_idx" ON "user_task_model_mapping_presets" USING btree ("user_id","name_key");--> statement-breakpoint
CREATE INDEX "user_task_model_mapping_presets_owner_created_idx" ON "user_task_model_mapping_presets" USING btree ("user_id","created_at");