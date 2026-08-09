CREATE TABLE "source_control_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_account_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_control_provider" text NOT NULL,
	"host" text NOT NULL,
	"external_account_id" text NOT NULL,
	"username" text,
	"display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_control_user_mappings" ADD CONSTRAINT "source_control_user_mappings_auth_account_id_auth_accounts_id_fk" FOREIGN KEY ("auth_account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_control_user_mappings" ADD CONSTRAINT "source_control_user_mappings_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_control_user_mappings_auth_account_unique" ON "source_control_user_mappings" USING btree ("auth_account_id");--> statement-breakpoint
CREATE INDEX "source_control_user_mappings_user_provider_host_idx" ON "source_control_user_mappings" USING btree ("user_id","source_control_provider","host");--> statement-breakpoint
CREATE UNIQUE INDEX "source_control_user_mappings_provider_identity_unique" ON "source_control_user_mappings" USING btree ("source_control_provider","host","external_account_id");