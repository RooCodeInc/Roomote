import {
  customAutomations,
  fastAgentConversations,
  fastAgentMessages,
  fastAgentParentEvents,
  sessionTasks,
  sessions,
  taskRuns,
  tasks,
} from '../schema';
import { sql } from 'drizzle-orm';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

type TaskAuth = { userId: string | null; isAdmin?: boolean };
type SessionAuth = { userId: string; isAdmin: boolean };

export function customAutomationTaskAccess(auth: TaskAuth) {
  if (auth.isAdmin) return undefined;
  // Attribution and participation are not ownership. Text comparison also
  // makes missing, malformed, and deleted automation provenance fail closed.
  return sql`(${tasks.initiatorAutomation} is distinct from 'custom_automation'
    or exists (
      select 1 from ${customAutomations} a
      where a.id::text = ${tasks.actorExternalId}
        and a.created_by_user_id = ${auth.userId}
    ))`;
}

export function customAutomationSessionAccess(auth: SessionAuth) {
  if (auth.isAdmin) return undefined;
  return sql`not exists (
    select 1 from ${sessionTasks} st
    inner join ${tasks} t on t.id = st.task_id
    where st.session_id = ${sessions.id}
      and t.initiator_automation = 'custom_automation'
      and not exists (
        select 1 from ${customAutomations} a
        where a.id::text = t.actor_external_id
          and a.created_by_user_id = ${auth.userId}
      )
  ) and (
    ${sessions.ownerAutomation} is distinct from 'custom_automation'
    or ${sessions.fastConversationId} is not null
    or exists (
      select 1 from ${sessionTasks} st
      inner join ${tasks} t on t.id = st.task_id
      where st.session_id = ${sessions.id}
        and t.initiator_automation = 'custom_automation'
    )
  ) and ${customAutomationFastSessionAccess(auth, true)}`;
}

export function customAutomationFastSessionAccess(
  auth: SessionAuth,
  forUnifiedSession = false,
) {
  if (auth.isAdmin) return undefined;
  const conversationId = forUnifiedSession
    ? sessions.fastConversationId
    : fastAgentConversations.id;

  // Fast automation runs are user-owned. Resolve the automation from durable
  // launch provenance, not the conversation's run-as user or participation.
  // Compare IDs as text so malformed/orphaned provenance fails closed.
  return sql`not exists (
    with conversation_ids as (
      select ${conversationId} as id
      union
      select unnest(c.legacy_conversation_ids)
      from ${fastAgentConversations} c where c.id = ${conversationId}
    )
    select 1 from (
      select e.event ->> 'automationId' as automation_id
      from ${fastAgentParentEvents} e
      where e.conversation_id in (select id from conversation_ids)
        and e.event ->> 'type' = 'automation_triggered'
      union all
      select substring(block ->> 'text' from '"automationId"[[:space:]]*:[[:space:]]*"([^"]+)"')
      from ${fastAgentMessages} m
      cross join lateral jsonb_array_elements(m.content_blocks) block
      where m.conversation_id in (select id from conversation_ids)
        and m.event_type = ${ACP_ENVELOPE_EVENT_TYPES.UserPrompt}
        and m.metadata ->> 'turnSource' = 'platform_event'
        and m.metadata ->> 'platformEventKind' = 'automation'
        and block ->> 'type' = 'text'
      union all
      select case when c.surface = 'automation'
        then c.workspace_id
        else split_part(c.conversation_id, ':', 1) end
      from ${fastAgentConversations} c
      where c.id in (select id from conversation_ids)
        and (c.owner_automation is null or c.owner_automation = 'custom_automation')
        and (c.surface = 'automation'
          or c.conversation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
          or c.owner_automation = 'custom_automation')
      union all
      select t.actor_external_id
      from ${tasks} t
      where t.initiator_automation = 'custom_automation'
        and (exists (
          select 1 from ${taskRuns} r
          where r.task_id = t.id
            and r.fast_agent_session_id in (select id from conversation_ids)
        ) or exists (
          select 1 from ${sessionTasks} st
          inner join ${sessions} s on s.id = st.session_id
          where st.task_id = t.id
            and s.fast_conversation_id in (select id from conversation_ids)
        ))
    ) provenance
    where not exists (
      select 1 from ${customAutomations} a
      where a.id::text = provenance.automation_id
        and a.created_by_user_id = ${auth.userId}
    )
  )`;
}
