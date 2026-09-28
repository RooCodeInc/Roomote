CREATE INDEX "fast_agent_messages_visible_user_order_idx" ON "fast_agent_messages" USING btree ("conversation_id","ts" DESC NULLS LAST) WHERE
        "fast_agent_messages"."role" = 'user'
        AND (
          "fast_agent_messages"."metadata" ->> 'visibleInTranscript' = 'true'
          OR (
            "fast_agent_messages"."metadata" ->> 'visibleInTranscript' IS NULL
            AND "fast_agent_messages"."event_type" <> 'roomote_runtime.user_prompt'
          )
        )
      ;
