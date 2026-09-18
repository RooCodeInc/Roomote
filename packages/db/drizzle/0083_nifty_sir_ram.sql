CREATE TABLE "user_personalizations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"manual_instructions" text,
	"explicit_conversation_instructions" text,
	"inferred_instructions" text,
	"learn_from_conversations" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_personalizations" ADD CONSTRAINT "user_personalizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;