ALTER TABLE "session_attention_notifications" ADD COLUMN "presentation_kind" text;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD COLUMN "delivery_channel" text;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD COLUMN "browser_prompt_eligible_at" timestamp;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD COLUMN "browser_offered_at" timestamp;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD COLUMN "browser_offer_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD COLUMN "browser_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD COLUMN "browser_opened_at" timestamp;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD COLUMN "browser_client_id" uuid;--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD CONSTRAINT "session_attention_notifications_presentation_kind_check" CHECK ("session_attention_notifications"."presentation_kind" IS NULL OR "session_attention_notifications"."presentation_kind" in ('response', 'error', 'input'));--> statement-breakpoint
ALTER TABLE "session_attention_notifications" ADD CONSTRAINT "session_attention_notifications_delivery_channel_check" CHECK ("session_attention_notifications"."delivery_channel" IS NULL OR "session_attention_notifications"."delivery_channel" in ('browser', 'personal_provider'));