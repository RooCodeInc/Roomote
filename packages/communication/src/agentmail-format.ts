/**
 * AgentMail email body formatting helpers.
 *
 * Converts the agent-authored markdown used across Roomote chat surfaces into
 * a conservative HTML email body plus a plain-text alternative. All source
 * text is HTML-escaped first — raw HTML never passes through, so an email
 * body can never carry injected markup.
 */

/**
 * Email size limits are generous, so no chunking — just a defensive cap so a
 * runaway agent reply cannot produce a multi-megabyte email.
 */
export const AGENTMAIL_MAX_TEXT_LENGTH = 100_000;

const TRUNCATION_SUFFIX = '\n\n[message truncated]';

function truncateAgentMailMarkdown(markdown: string): string {
  if (markdown.length <= AGENTMAIL_MAX_TEXT_LENGTH) {
    return markdown;
  }

  return (
    markdown.slice(0, AGENTMAIL_MAX_TEXT_LENGTH - TRUNCATION_SUFFIX.length) +
    TRUNCATION_SUFFIX
  );
}

function escapeAgentMailHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Only link protocols that are safe in an email client. Anything else
 * (javascript:, data:, file:, …) stays literal escaped text.
 */
const SAFE_LINK_PATTERN = /^(https?:\/\/|mailto:)/i;

function convertInlineMarkdown(escaped: string): string {
  return (
    escaped
      // Links first so their URLs are not touched by emphasis rules. The
      // text was already escaped, so `&` inside URLs appears as `&amp;`,
      // which is the correct encoding for an href attribute.
      .replace(
        /\[([^\]\n]+)\]\(([^\s)]+)\)/g,
        (match, label: string, url: string) =>
          SAFE_LINK_PATTERN.test(url) ? `<a href="${url}">${label}</a>` : match,
      )
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<em>$1</em>')
      // Underscore italics only when they wrap a whole line, so snake_case
      // identifiers inside prose are never touched.
      .replace(/^_([^_\n](?:[^\n]*[^_\n])?)_$/gm, '<em>$1</em>')
  );
}

function convertInlineText(line: string): string {
  const escaped = escapeAgentMailHtml(line);

  // Convert inline code spans before emphasis so their contents stay
  // verbatim, then apply emphasis/link conversion outside <code> spans only.
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .split(/(<code>[^<]*<\/code>)/g)
    .map((part) =>
      part.startsWith('<code>') ? part : convertInlineMarkdown(part),
    )
    .join('');
}

type MarkdownSegment =
  | { kind: 'text'; content: string }
  | { kind: 'code'; content: string; language?: string };

function splitCodeFences(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const fencePattern = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let lastIndex = 0;

  for (const match of markdown.matchAll(fencePattern)) {
    const index = match.index ?? 0;

    if (index > lastIndex) {
      segments.push({
        kind: 'text',
        content: markdown.slice(lastIndex, index),
      });
    }

    segments.push({
      kind: 'code',
      content: match[2] ?? '',
      ...(match[1]?.trim() ? { language: match[1].trim() } : {}),
    });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < markdown.length) {
    segments.push({ kind: 'text', content: markdown.slice(lastIndex) });
  }

  return segments;
}

type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'blockquote'; lines: string[] }
  | { kind: 'unordered-list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'paragraph'; lines: string[] };

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const UNORDERED_ITEM_PATTERN = /^[-*+]\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^\d+[.)]\s+(.*)$/;
const BLOCKQUOTE_PATTERN = /^>\s?(.*)$/;

function splitBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let current: MarkdownBlock | null = null;

  const flush = () => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = HEADING_PATTERN.exec(line);

    if (heading?.[1] && heading[2] !== undefined) {
      flush();
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        text: heading[2],
      });
      continue;
    }

    const blockquote = BLOCKQUOTE_PATTERN.exec(line);

    if (blockquote) {
      if (current?.kind === 'blockquote') {
        current.lines.push(blockquote[1] ?? '');
      } else {
        flush();
        current = { kind: 'blockquote', lines: [blockquote[1] ?? ''] };
      }
      continue;
    }

    const unordered = UNORDERED_ITEM_PATTERN.exec(line);

    if (unordered) {
      if (current?.kind === 'unordered-list') {
        current.items.push(unordered[1] ?? '');
      } else {
        flush();
        current = { kind: 'unordered-list', items: [unordered[1] ?? ''] };
      }
      continue;
    }

    const ordered = ORDERED_ITEM_PATTERN.exec(line);

    if (ordered) {
      if (current?.kind === 'ordered-list') {
        current.items.push(ordered[1] ?? '');
      } else {
        flush();
        current = { kind: 'ordered-list', items: [ordered[1] ?? ''] };
      }
      continue;
    }

    if (current?.kind === 'paragraph') {
      current.lines.push(line);
    } else {
      flush();
      current = { kind: 'paragraph', lines: [line] };
    }
  }

  flush();

  return blocks;
}

/** Headings render one size down (h3–h5) to stay email-friendly. */
function headingTag(level: number): string {
  return level <= 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
}

function renderBlock(block: MarkdownBlock): string {
  switch (block.kind) {
    case 'heading': {
      const tag = headingTag(block.level);

      return `<${tag}>${convertInlineText(block.text)}</${tag}>`;
    }
    case 'blockquote':
      return `<blockquote><p>${block.lines
        .map((line) => convertInlineText(line))
        .join('<br />')}</p></blockquote>`;
    case 'unordered-list':
      return `<ul>${block.items
        .map((item) => `<li>${convertInlineText(item)}</li>`)
        .join('')}</ul>`;
    case 'ordered-list':
      return `<ol>${block.items
        .map((item) => `<li>${convertInlineText(item)}</li>`)
        .join('')}</ol>`;
    case 'paragraph':
      return `<p>${block.lines
        .map((line) => convertInlineText(line))
        .join('<br />')}</p>`;
  }
}

/**
 * Convert Roomote markdown to a conservative HTML email body. Supports
 * paragraphs, bold, italic, inline code, fenced code blocks, safe links
 * (http/https/mailto only), unordered/ordered lists, headings (rendered
 * h3–h5), blockquotes, and line breaks. Everything else passes through as
 * escaped text.
 */
export function renderAgentMailHtml(markdown: string): string {
  return splitCodeFences(truncateAgentMailMarkdown(markdown))
    .map((segment) => {
      if (segment.kind === 'code') {
        const escaped = escapeAgentMailHtml(segment.content.replace(/\n$/, ''));

        return segment.language
          ? `<pre><code class="language-${escapeAgentMailHtml(segment.language)}">${escaped}</code></pre>`
          : `<pre><code>${escaped}</code></pre>`;
      }

      return splitBlocks(segment.content).map(renderBlock).join('');
    })
    .join('');
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
    .replace(/^_([^_\n](?:[^\n]*[^_\n])?)_$/gm, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}

/**
 * Strip markdown down to readable plain text for the email's text/plain
 * alternative. Links render as "label (url)"; list markers and blockquote
 * text stay readable as-is.
 */
export function renderAgentMailPlainText(markdown: string): string {
  return splitCodeFences(truncateAgentMailMarkdown(markdown))
    .map((segment) => {
      if (segment.kind === 'code') {
        return segment.content.replace(/\n$/, '');
      }

      return segment.content
        .split('\n')
        .map((line) => {
          const heading = HEADING_PATTERN.exec(line);
          const blockquote = BLOCKQUOTE_PATTERN.exec(line);
          const source = heading?.[2] ?? blockquote?.[1] ?? line;

          return stripInlineMarkdown(source);
        })
        .join('\n');
    })
    .join('\n')
    .trim();
}

/**
 * Build the HTML body plus plain-text alternative for one outbound email.
 * The HTML is wrapped in a minimal `<div>` — email clients supply the
 * surrounding `<html>`/`<head>` themselves.
 */
export function buildAgentMailEmailBody(markdown: string): {
  html: string;
  text: string;
} {
  const truncated = truncateAgentMailMarkdown(markdown);

  return {
    html: `<div>${renderAgentMailHtml(truncated)}</div>`,
    text: renderAgentMailPlainText(truncated),
  };
}
