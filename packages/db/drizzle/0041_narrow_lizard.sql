CREATE TABLE "slack_directory_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"username" text,
	"display_name" text,
	"real_name" text,
	"title" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"is_app_user" boolean DEFAULT false NOT NULL,
	"profile_updated_at" timestamp,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "slack_directory_users_unique" UNIQUE("slack_user_id","slack_team_id")
);
--> statement-breakpoint
CREATE INDEX "slack_directory_users_team_id_idx" ON "slack_directory_users" USING btree ("slack_team_id");