CREATE TABLE "brain_page_retirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "brain_page_retirements_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE INDEX "brain_page_retirements_status_created_idx" ON "brain_page_retirements" USING btree ("status","created_at");