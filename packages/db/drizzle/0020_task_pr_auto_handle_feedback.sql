ALTER TABLE "task_pull_requests" ADD COLUMN "auto_handle_feedback_by_user_id" text;--> statement-breakpoint
ALTER TABLE "task_pull_requests" ADD CONSTRAINT "task_pull_requests_auto_handle_feedback_by_user_id_users_id_fk" FOREIGN KEY ("auto_handle_feedback_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
