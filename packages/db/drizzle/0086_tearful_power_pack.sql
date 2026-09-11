ALTER TABLE "automation_results" ADD COLUMN "source_work_item_id" uuid;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "kind" text DEFAULT 'report' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_results" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "automation_results" ADD CONSTRAINT "automation_results_source_work_item_id_work_items_id_fk" FOREIGN KEY ("source_work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_results_source_work_item_id_unique_idx" ON "automation_results" USING btree ("source_work_item_id");--> statement-breakpoint

-- N-1 bridge: the current release owns suggestion inbox state in
-- automation_results. These triggers keep the previous release's work_items
-- reads and writes synchronized during rollout and after a one-release rollback.
CREATE FUNCTION "serialize_automation_result_bridge_writes"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(
		hashtextextended('automation-result-work-item-bridge', 0)
	);
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "sync_legacy_work_item_result_to_canonical"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF pg_trigger_depth() > 1
		OR NEW."kind" <> 'suggestion'
		OR NEW."result_automation_name" IS NULL THEN
		RETURN NEW;
	END IF;

	INSERT INTO "automation_results" AS canonical (
		"automation_key",
		"source_task_id",
		"source_work_item_id",
		"user_id",
		"kind",
		"automation_name",
		"title",
		"content",
		"priority",
		"dedupe_key",
		"accepted_at",
		"ignored_at",
		"created_at",
		"updated_at"
	) VALUES (
		NEW."automation_key",
		NEW."source_task_id",
		NEW."id",
		NEW."result_user_id",
		'suggestion',
		NEW."result_automation_name",
		NEW."title",
		COALESCE(NEW."brief", ''),
		COALESCE(NEW."result_priority", 'normal'),
		'work-item:' || NEW."id"::text,
		NEW."result_accepted_at",
		NEW."result_ignored_at",
		NEW."created_at",
		NEW."updated_at"
	)
	ON CONFLICT ("source_work_item_id") DO UPDATE
	SET
		"automation_key" = EXCLUDED."automation_key",
		"source_task_id" = EXCLUDED."source_task_id",
		"user_id" = EXCLUDED."user_id",
		"automation_name" = EXCLUDED."automation_name",
		"title" = EXCLUDED."title",
		"content" = EXCLUDED."content",
		"priority" = EXCLUDED."priority",
		"accepted_at" = EXCLUDED."accepted_at",
		"ignored_at" = EXCLUDED."ignored_at",
		"updated_at" = EXCLUDED."updated_at";

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "sync_canonical_suggestion_result_to_legacy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF pg_trigger_depth() > 1
		OR NEW."kind" <> 'suggestion'
		OR NEW."source_work_item_id" IS NULL THEN
		RETURN NEW;
	END IF;

	UPDATE "work_items"
	SET
		"result_automation_name" = NEW."automation_name",
		"result_priority" = NEW."priority",
		"result_user_id" = NEW."user_id",
		"result_accepted_at" = NEW."accepted_at",
		"result_ignored_at" = NEW."ignored_at",
		"updated_at" = NEW."updated_at"
	WHERE "id" = NEW."source_work_item_id";

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "serialize_legacy_work_item_result_bridge_writes"
BEFORE INSERT OR UPDATE ON "work_items"
FOR EACH STATEMENT
EXECUTE FUNCTION "serialize_automation_result_bridge_writes"();--> statement-breakpoint

CREATE TRIGGER "serialize_canonical_automation_result_bridge_writes"
BEFORE INSERT OR UPDATE ON "automation_results"
FOR EACH STATEMENT
EXECUTE FUNCTION "serialize_automation_result_bridge_writes"();--> statement-breakpoint

CREATE TRIGGER "sync_legacy_work_item_result_to_canonical"
AFTER INSERT OR UPDATE OF
	"automation_key",
	"source_task_id",
	"result_user_id",
	"result_automation_name",
	"result_priority",
	"result_accepted_at",
	"result_ignored_at",
	"title",
	"brief",
	"updated_at"
ON "work_items"
FOR EACH ROW
EXECUTE FUNCTION "sync_legacy_work_item_result_to_canonical"();--> statement-breakpoint

CREATE TRIGGER "sync_canonical_suggestion_result_to_legacy"
AFTER INSERT OR UPDATE OF
	"user_id",
	"automation_name",
	"priority",
	"accepted_at",
	"ignored_at",
	"updated_at"
ON "automation_results"
FOR EACH ROW
EXECUTE FUNCTION "sync_canonical_suggestion_result_to_legacy"();--> statement-breakpoint

INSERT INTO "automation_results" (
	"automation_key",
	"source_task_id",
	"source_work_item_id",
	"user_id",
	"kind",
	"automation_name",
	"title",
	"content",
	"priority",
	"dedupe_key",
	"accepted_at",
	"ignored_at",
	"created_at",
	"updated_at"
)
SELECT
	"automation_key",
	"source_task_id",
	"id",
	"result_user_id",
	'suggestion',
	"result_automation_name",
	"title",
	COALESCE("brief", ''),
	COALESCE("result_priority", 'normal'),
	'work-item:' || "id"::text,
	"result_accepted_at",
	"result_ignored_at",
	"created_at",
	"updated_at"
FROM "work_items"
WHERE "kind" = 'suggestion'
	AND "result_automation_name" IS NOT NULL
ON CONFLICT ("source_work_item_id") DO NOTHING;
