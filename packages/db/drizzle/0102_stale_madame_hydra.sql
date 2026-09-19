CREATE TABLE "agentmail_reply_verification_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"email_address" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentmail_reply_verification_proofs_token_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "agentmail_reply_verification_proofs" ADD CONSTRAINT "agentmail_reply_verification_proofs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agentmail_reply_verification_proofs_user_idx" ON "agentmail_reply_verification_proofs" USING btree ("user_id","email_address");