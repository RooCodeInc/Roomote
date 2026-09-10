/**
 * Text preparation for spoken replies in the live voice conversation
 * feature. Agent replies are markdown written for reading, so structural
 * syntax is stripped or summarized before the text is returned to GPT-Live.
 */

/** Stays comfortably below GPT-Live's 500-token append limit. */
const VOICE_SPEECH_CHUNK_CHARS = 1_200;

/**
 * Convert an agent's markdown reply into text worth speaking aloud. Code
 * blocks are summarized rather than read character-by-character, links keep
 * their label but drop the URL, and formatting markers disappear.
 */
export function toSpeakableText(markdown: string): string {
  let text = markdown;

  // Fenced code blocks: reading code aloud is noise; acknowledge and move on.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, ' Code block omitted. ');

  // Images before links, so ![alt](url) doesn't leave a stray "!".
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Bare URLs read as gibberish.
  text = text.replace(/https?:\/\/\S+/g, 'a link');

  // Inline code keeps its content, minus the backticks.
  text = text.replace(/`([^`]+)`/g, '$1');

  // Table rows: drop separator lines, read cells as phrases.
  text = text.replace(/^\s*\|?[-:| ]+\|[-:| ]*$/gm, '');
  text = text.replace(/\s*\|\s*/g, ', ');

  // Headings, blockquotes, list markers, emphasis, strikethrough.
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s*>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/(\*\*|__|~~)/g, '');

  // Collapse the leftover whitespace so pauses stay natural.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{2,}/g, '\n');

  return text.trim();
}

/**
 * Split a long reply into GPT-Live commentary appends, preferring paragraph
 * and sentence boundaries.
 */
export function chunkSpeakableText(
  text: string,
  maxChars = VOICE_SPEECH_CHUNK_CHARS,
): string[] {
  const trimmed = text.trim();

  if (!trimmed) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const newlineBreak = window.lastIndexOf('\n');
    const sentenceBreak = findLastSentenceEnd(window);
    const spaceBreak = window.lastIndexOf(' ');
    const breakAt =
      newlineBreak > 0
        ? newlineBreak
        : sentenceBreak > 0
          ? sentenceBreak
          : spaceBreak;
    const splitAt = breakAt > 0 ? breakAt + 1 : maxChars;
    const chunk = remaining.slice(0, splitAt).trim();

    if (chunk) {
      chunks.push(chunk);
    }

    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findLastSentenceEnd(window: string): number {
  for (let i = window.length - 2; i >= 0; i--) {
    const char = window[i];

    if (
      (char === '.' || char === '!' || char === '?') &&
      window[i + 1] === ' '
    ) {
      return i + 1;
    }
  }

  return -1;
}
