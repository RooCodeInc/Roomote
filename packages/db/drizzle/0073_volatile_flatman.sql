CREATE TABLE "fast_agent_turn_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"signature" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fast_agent_turn_effects" ADD CONSTRAINT "fast_agent_turn_effects_parent_event_id_fast_agent_parent_events_id_fk" FOREIGN KEY ("parent_event_id") REFERENCES "public"."fast_agent_parent_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fast_agent_turn_effects_signature_unique" ON "fast_agent_turn_effects" USING btree ("parent_event_id","kind","signature");