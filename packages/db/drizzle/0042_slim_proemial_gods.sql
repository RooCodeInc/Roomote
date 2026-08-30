CREATE TABLE "brain_collector_items" (
	"collector_id" text NOT NULL,
	"item_id" text NOT NULL,
	"slug" text NOT NULL,
	"last_seen_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "brain_collector_items_collector_item_pk" PRIMARY KEY("collector_id","item_id")
);
--> statement-breakpoint
CREATE INDEX "brain_collector_items_collector_seen_idx" ON "brain_collector_items" USING btree ("collector_id","last_seen_at");