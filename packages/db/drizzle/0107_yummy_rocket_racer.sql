CREATE TABLE "desktop_device_audit" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "desktop_device_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"device_id" uuid,
	"owner_user_id" text,
	"event" text NOT NULL,
	"actor_user_id" text,
	"request_id" uuid,
	"action" text,
	"outcome" text,
	"duration_ms" integer,
	"response_bytes" integer,
	"error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desktop_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"protocol_version" integer NOT NULL,
	"last_instance_id" text,
	"last_connected_at" timestamp,
	"last_disconnected_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by_user_id" text,
	"revoke_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desktop_device_audit" ADD CONSTRAINT "desktop_device_audit_device_id_desktop_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."desktop_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_device_audit" ADD CONSTRAINT "desktop_device_audit_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_device_audit" ADD CONSTRAINT "desktop_device_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_devices" ADD CONSTRAINT "desktop_devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_devices" ADD CONSTRAINT "desktop_devices_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_device_audit_device_created_idx" ON "desktop_device_audit" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "desktop_devices_owner_idx" ON "desktop_devices" USING btree ("owner_user_id","created_at");