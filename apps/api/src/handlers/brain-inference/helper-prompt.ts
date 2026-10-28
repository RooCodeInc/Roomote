function messageContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .flatMap((part) => {
        const record =
          part && typeof part === 'object'
            ? (part as Record<string, unknown>)
            : undefined;

        return typeof record?.text === 'string' ? [record.text] : [];
      })
      .join('\n');
  }

  return '';
}

/**
 * Convert an OpenAI chat request into the system/prompt pair
 * generateTrackedNonTaskText speaks.
 */
export function toHelperPromptParts(messages: unknown): {
  system: string;
  prompt: string;
} {
  const systemParts: string[] = [];
  const promptParts: string[] = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const record =
      message && typeof message === 'object'
        ? (message as Record<string, unknown>)
        : undefined;
    const role = typeof record?.role === 'string' ? record.role : 'user';
    const text = messageContentText(record?.content);

    if (!text.trim()) {
      continue;
    }

    if (role === 'system') {
      systemParts.push(text);
    } else if (role === 'user') {
      promptParts.push(text);
    } else {
      promptParts.push(
        `${role.charAt(0).toUpperCase()}${role.slice(1)}: ${text}`,
      );
    }
  }

  return {
    system: systemParts.join('\n\n'),
    prompt: promptParts.join('\n\n'),
  };
}

export function jsonResponseInstruction(
  responseFormat: unknown,
): string | null {
  const record =
    responseFormat && typeof responseFormat === 'object'
      ? (responseFormat as Record<string, unknown>)
      : undefined;

  if (record?.type === 'json_object') {
    return 'Respond with only valid JSON. No prose, no code fences.';
  }

  if (record?.type === 'json_schema') {
    return `Respond with only valid JSON that conforms to this JSON Schema. No prose, no code fences.\n${JSON.stringify(record.json_schema ?? {})}`;
  }

  return null;
}
