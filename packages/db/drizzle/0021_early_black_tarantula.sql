CREATE TABLE "user_routing_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"correction_count" integer DEFAULT 1 NOT NULL,
	"last_corrected_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_routing_preferences" ADD CONSTRAINT "user_routing_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_routing_preferences" ADD CONSTRAINT "user_routing_preferences_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_routing_preferences_user_unique" ON "user_routing_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_routing_preferences_environment_idx" ON "user_routing_preferences" USING btree ("environment_id");