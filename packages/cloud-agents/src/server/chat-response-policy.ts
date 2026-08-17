export type ChatResponseSurface = 'slack' | 'discord' | 'teams' | 'telegram';

export interface ChatResponseDecisionPolicy {
  lifecycle: string;
  acknowledgement: string;
  progress: string;
  closeout: string;
  clarification: string;
  continuation: string;
  freshResponse: string;
}

function getSurfaceLabel(surface: ChatResponseSurface): string {
  if (surface === 'slack') {
    return 'Slack';
  }
  if (surface === 'discord') {
    return 'Discord';
  }
  if (surface === 'telegram') {
    return 'Telegram';
  }
  return 'Teams';
}

export function buildChatResponseDecisionPolicy({
  surface,
  reactionsAvailable = true,
}: {
  surface: ChatResponseSurface;
  reactionsAvailable?: boolean;
}): ChatResponseDecisionPolicy {
  const label = getSurfaceLabel(surface);
  const acknowledgement = reactionsAvailable
    ? `\`ack\`: Send one early ${label}-visible acknowledgement before substantial work that will not otherwise post to ${label} when the answer is not immediate. When the current turn allows emoji reactions and a lightweight acknowledgement is enough, prefer \`send_chat_reaction_emoji\` over a short text ack. When the acknowledgement needs words or reactions are not allowed, use \`send_chat_reply\`. If the first ${label}-visible action already answers or completes the turn, that action is the acknowledgement and no separate ack is needed.`
    : `\`ack\`: Send one early ${label}-visible acknowledgement before substantial work that will not otherwise post to ${label} when the answer is not immediate. Use \`send_chat_reply\` because emoji reactions are unavailable. If the first ${label}-visible action already answers or completes the turn, that action is the acknowledgement and no separate ack is needed.`;

  return {
    lifecycle: `A ${label} user turn has a small lifecycle: acknowledge the turn when needed, report useful progress when there is useful new state, and close out when there is an answer, result, blocker, or a clear paused-waiting state. ${label} uses this lifecycle for user-visible replies instead of treating ${label} as an intermediary-update surface. One ${label} message can satisfy multiple lifecycle purposes only when its content genuinely does so.`,
    acknowledgement,
    progress: `\`progress\`: After an acknowledgement, send progress only when the update adds decision-useful state since the last ${label}-visible reply: a material result, blocker, input need, changed approach, meaningful phase transition, proof artifact, or a timed update that prevents more than 10 minutes of ${label}-visible silence during active work. When that timed update is warranted, keep it brief and outcome-level: say what is materially true now and what happens next in user terms instead of turning ${label} into a running work log.`,
    closeout: `\`closeout\`: Send one ${label}-visible closeout when the turn has an answer, completed result, explicit blocker, or a paused-waiting state that you explain in prose. This is the only terminal \`send_chat_reply\` purpose. If a prior ${label}-visible reply already resolved the turn, the closeout can be brief and should make that outcome clear. Do not send another closeout that restates the same delivery outcome (for example the same PR link and self-review note) after internal bookkeeping, validation, or helper follow-up unless the user-visible outcome actually changed.`,
    clarification: `\`clarification\`: Ask one lightweight question with \`send_chat_reply\` only when conversation context and available tools do not already resolve it well enough to continue.`,
    continuation: `An \`ack\` or \`progress\` reply does not end the turn. Keep working after sending it. The turn ends on a \`closeout\`, on a clarification whose answer the next step genuinely depends on, or on an explicit user instruction to pause or stop.`,
    freshResponse: `Every new directed ${label} user turn that you answer needs its own fresh ${label}-visible response. A prior turn's reply or reaction does not satisfy a later turn.`,
  };
}
