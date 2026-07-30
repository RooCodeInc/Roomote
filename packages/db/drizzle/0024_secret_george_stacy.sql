CREATE TABLE "monday_agent_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'default',
	"account_id" text NOT NULL,
	"account_name" text,
	"agent_id" text NOT NULL,
	"owner_mcp_connection_id" uuid NOT NULL,
	"agent_api_token" text NOT NULL,
	"signing_secret" text NOT NULL,
	"status" text DEFAULT 'inactive' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "monday_agent_installations_singleton_unique" UNIQUE("singleton_key"),
	CONSTRAINT "monday_agent_installations_agent_id_unique" UNIQUE("agent_id"),
	CONSTRAINT "monday_agent_installations_singleton_key_check" CHECK ("monday_agent_installations"."singleton_key" = 'default' OR ("monday_agent_installations"."singleton_key" IS NULL AND "monday_agent_installations"."status" = 'error'))
);
--> statement-breakpoint
ALTER TABLE "monday_agent_installations" ADD CONSTRAINT "monday_agent_installations_owner_mcp_connection_id_mcp_connections_id_fk" FOREIGN KEY ("owner_mcp_connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monday_agent_installations_account_id_idx" ON "monday_agent_installations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "monday_agent_installations_owner_connection_idx" ON "monday_agent_installations" USING btree ("owner_mcp_connection_id");