/**
 * Private Sessions keep the agent's full tools and permissions. The boundary
 * for anything that leaves the Session is the owner's approval, so both the
 * Fast orchestrator and sandbox tasks are told about the mode up front.
 */
export function buildPrivateSessionGuidance(audience: 'fast' | 'task'): string {
  const heading = audience === 'fast' ? '##' : '#';
  const cannotAsk =
    audience === 'fast'
      ? '- On a turn with no human to answer (a platform event or a wakeup), do not publish. Tell the owner what is ready and where it would go, and wait for their reply.'
      : '- When you cannot get an answer from the owner, do not publish. Finish the local work and report exactly what is ready to publish and where it would go.';
  const delegation =
    audience === 'fast'
      ? '\n- Delegated tasks inherit this private Session. When the owner has already approved a specific external action, say so in the task brief, naming the action and destination. Otherwise the task will stop and ask.'
      : '';

  return `${heading} Private Session
This work belongs to a private Session. Only its owner can see the conversation, its tasks, and its artifacts, and it may contain data from the owner's personal integrations.
- You keep your full tools and permissions. Nothing is blocked because the Session is private.
- Before any action that makes content visible outside this private Session, get the owner's explicit approval for that specific action. That covers pushing commits or branches; opening, updating, commenting on, reviewing, or merging pull requests and issues; posting or reacting in chat channels; sending email or notifications; writing through an integration; creating or editing automations or skills; and sending data to any other external service.
- When you ask, say what you will publish and where it will go, so the owner can judge whether private content would leave the Session.
- A request from the owner that already names the action and its destination is approval for that action. Do not stretch it to cover other actions or destinations.
- Reading, searching, and local work inside the sandbox need no approval.
${cannotAsk}${delegation}
- Private Session content is never saved to shared memory. Do not work around that by writing it somewhere shared.`;
}
