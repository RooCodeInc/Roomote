ALTER TABLE "fast_agent_conversations" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD COLUMN "owner_automation" text;--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD CONSTRAINT "fast_agent_conversations_owner_automation_automations_key_fk" FOREIGN KEY ("owner_automation") REFERENCES "public"."automations"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fast_agent_conversations_owner_automation_idx" ON "fast_agent_conversations" USING btree ("owner_automation");--> statement-breakpoint
ALTER TABLE "fast_agent_conversations" ADD CONSTRAINT "fast_agent_conversations_owner_shape_check" CHECK ((
        ("fast_agent_conversations"."user_id" is not null and "fast_agent_conversations"."owner_automation" is null)
        or
        ("fast_agent_conversations"."user_id" is null and "fast_agent_conversations"."owner_automation" is not null)
      ));