CREATE TABLE "task_follow_up_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" integer GENERATED ALWAYS AS IDENTITY (sequence name "task_follow_up_messages_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_id" integer NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text,
	"prompt" text NOT NULL,
	"quote_text" text NOT NULL,
	"images" jsonb,
	"source" text,
	"user_name" text,
	"user_image_url" text,
	"worker_quote_user_name" text,
	"client_message_id" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"accepted_at" timestamp,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_follow_up_messages" ADD CONSTRAINT "task_follow_up_messages_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_follow_up_messages" ADD CONSTRAINT "task_follow_up_messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_follow_up_messages" ADD CONSTRAINT "task_follow_up_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_follow_up_messages_task_client_id_unique" ON "task_follow_up_messages" USING btree ("task_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_follow_up_messages_sequence_unique" ON "task_follow_up_messages" USING btree ("sequence");--> statement-breakpoint
CREATE INDEX "task_follow_up_messages_run_pending_idx" ON "task_follow_up_messages" USING btree ("run_id","status","sequence");--> statement-breakpoint
CREATE INDEX "task_follow_up_messages_task_pending_idx" ON "task_follow_up_messages" USING btree ("task_id","status","sequence");