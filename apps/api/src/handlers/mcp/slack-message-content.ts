import { Env } from '@roomote/env';

export function getSlackFallbackText(
  text: string | undefined,
  imageCount: number,
): string {
  return (
    text ??
    `Shared ${imageCount} image attachment${imageCount === 1 ? '' : 's'}`
  );
}

export function absolutizeSetupMarkdownLinks(text: string): string {
  const origin = Env.R_APP_URL;

  return text.replace(
    /\[([^\]]+)\]\((\/setup(?:[/?#][^)]+)?)\)/g,
    (_match, label: string, path: string) => `[${label}](${origin}${path})`,
  );
}

export function absolutizeSetupMarkdownBlocks(
  blocks: unknown[] | undefined,
): unknown[] | undefined {
  if (!blocks) {
    return blocks;
  }

  return blocks.map((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return block;
    }

    if (
      (block as { type?: unknown }).type !== 'markdown' ||
      typeof (block as { text?: unknown }).text !== 'string'
    ) {
      return block;
    }

    return {
      ...block,
      text: absolutizeSetupMarkdownLinks((block as { text: string }).text),
    };
  });
}
