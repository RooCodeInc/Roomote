import type {
  CommunicationProvider,
  QueuedCommunicationMessage,
} from './communication';

type CommunicationPromptMessage = Pick<
  QueuedCommunicationMessage,
  'channel' | 'text' | 'threadTs' | 'ts' | 'user' | 'turnPolicy'
>;

function escapeCommunicationPromptContent(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeCommunicationPromptAttribute(value: string): string {
  return escapeCommunicationPromptContent(value).replaceAll('"', '&quot;');
}

function wrapCommunicationTurnPolicy(
  provider: CommunicationProvider,
  turnPolicy: NonNullable<QueuedCommunicationMessage['turnPolicy']>,
): string {
  const reactionsAllowed = turnPolicy.reactionsAllowed === true;
  // Match Slack follow-up policy: when reactions are allowed on the turn,
  // prefer a lightweight emoji ack over short text when that is enough.
  const preferEmojiAck = reactionsAllowed;
  const tag = `${provider}_turn_policy`;
  const guidance = reactionsAllowed
    ? `Emoji reactions are allowed on the current ${provider} message. Prefer \`send_chat_reaction_emoji\` instead of a short text acknowledgement when a lightweight acknowledgement or emoji-only answer is enough.`
    : `Emoji reactions are not allowed on the current ${provider} message. Use \`send_chat_reply\` for acknowledgements and lightweight clarification. Use \`request_user_input\` only when the task actually needs structured or private input from the user.`;

  return `<${tag} reactions_allowed="${reactionsAllowed ? 'true' : 'false'}" prefer_emoji_ack="${preferEmojiAck ? 'true' : 'false'}">\n${escapeCommunicationPromptContent(guidance)}\n</${tag}>`;
}

export function wrapCommunicationMessage(
  provider: CommunicationProvider,
  message: CommunicationPromptMessage,
): string {
  const attributes = [
    `provider="${provider}"`,
    `ts="${escapeCommunicationPromptAttribute(message.ts)}"`,
  ];

  if (message.user?.trim()) {
    attributes.push(
      `author="${escapeCommunicationPromptAttribute(message.user.trim())}"`,
    );
  }

  if (message.channel?.trim()) {
    attributes.push(
      `channel="${escapeCommunicationPromptAttribute(message.channel.trim())}"`,
    );
  }

  if (message.threadTs?.trim()) {
    attributes.push(
      `thread="${escapeCommunicationPromptAttribute(message.threadTs.trim())}"`,
    );
  }

  const body = `<communication_message ${attributes.join(' ')}>\n${escapeCommunicationPromptContent(message.text.trim())}\n</communication_message>`;

  if (!message.turnPolicy) {
    return body;
  }

  return `${wrapCommunicationTurnPolicy(provider, message.turnPolicy)}\n\n${body}`;
}
