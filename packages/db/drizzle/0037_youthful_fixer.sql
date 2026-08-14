CREATE TABLE "repository_automation_signals" (
	"repository_id" uuid NOT NULL,
	"signals_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"collected_at" timestamp DEFAULT now() NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	CONSTRAINT "repository_automation_signals_repository_id_signals_version_pk" PRIMARY KEY("repository_id","signals_version")
);
--> statement-breakpoint
ALTER TABLE "repository_automation_signals" ADD CONSTRAINT "repository_automation_signals_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repository_automation_signals_collected_idx" ON "repository_automation_signals" USING btree ("collected_at");