CREATE TABLE "notion_directory_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notion_user_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notion_directory_users_unique" UNIQUE("notion_user_id")
);
