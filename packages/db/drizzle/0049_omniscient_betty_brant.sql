CREATE TABLE "fast_agent_pr_feedback_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"feedback_id" text NOT NULL,
	"task_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fast_agent_pr_feedback_deliveries" ADD CONSTRAINT "fast_agent_pr_feedback_deliveries_conversation_id_fast_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."fast_agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fast_agent_pr_feedback_deliveries" ADD CONSTRAINT "fast_agent_pr_feedback_deliveries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fast_agent_pr_feedback_deliveries_identity_unique" ON "fast_agent_pr_feedback_deliveries" USING btree ("conversation_id","feedback_id");--> statement-breakpoint
CREATE INDEX "fast_agent_pr_feedback_deliveries_task_idx" ON "fast_agent_pr_feedback_deliveries" USING btree ("task_id");