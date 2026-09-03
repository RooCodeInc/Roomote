import type { TaskMessageContentBlock } from '@roomote/types';

/**
 * Builds the canonical content blocks for a human prompt: the text first,
 * then one image block per base64 data URL that parses.
 */
export function buildFastAgentUserContentBlocks(
  text: string,
  images: string[],
): TaskMessageContentBlock[] {
  const blocks: TaskMessageContentBlock[] = [{ type: 'text', text }];

  for (const image of images) {
    const match = /^data:(image\/[^;,]+);base64,(.+)$/i.exec(image.trim());
    if (match?.[1] && match[2]) {
      blocks.push({ type: 'image', mimeType: match[1], data: match[2] });
    }
  }

  return blocks;
}
