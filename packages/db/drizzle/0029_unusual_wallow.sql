CREATE TABLE "custom_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"headers" jsonb,
	"stdio" jsonb,
	"disabled_tools" text[],
	"manual_client_id" text,
	"manual_client_secret" text,
	"oauth_server_metadata" jsonb,
	"oauth_server_metadata_fetched_at" timestamp,
	"oauth_resource_indicator_disabled" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "custom_mcp_servers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "custom_mcp_servers" ADD CONSTRAINT "custom_mcp_servers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;