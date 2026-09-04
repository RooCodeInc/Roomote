ALTER TABLE "task_artifacts" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_artifacts_session_id_idx" ON "task_artifacts" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_artifacts_session_id_path_version_unique" ON "task_artifacts" USING btree ("session_id","path","version") WHERE "task_artifacts"."session_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_owner_shape_check" CHECK (("task_artifacts"."task_id" IS NOT NULL) <> ("task_artifacts"."session_id" IS NOT NULL));