CREATE TABLE "automation_webhook_daily_budgets" (
	"day" text PRIMARY KEY NOT NULL,
	"reservations" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_webhook_triggers" DROP CONSTRAINT "automation_webhook_triggers_connection_id_mcp_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_webhook_triggers" ALTER COLUMN "approved_by_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "automation_webhook_triggers" ADD CONSTRAINT "automation_webhook_triggers_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhook_triggers" ADD CONSTRAINT "automation_webhook_triggers_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE restrict ON UPDATE no action;