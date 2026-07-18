import type {
  CommunicationProvider,
  QueuedCommunicationMessage,
} from './communication';

type CommunicationPromptMessage = Pick<
  QueuedCommunicationMessage,
  'channel' | 'text' | 'threadTs' | 'ts' | 'user'
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

  return `<communication_message ${attributes.join(' ')}>\n${escapeCommunicationPromptContent(message.text.trim())}\n</communication_message>`;
}
