import type { SlackFile } from './types';

const MAX_FORWARDED_MESSAGE_TEXT_LENGTH = 4_000;

function isSlackLinkScheme(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('mailto:')
  );
}

function replaceSlackLinks(
  text: string,
  onMarkdown: (url: string, label: string) => string,
  onBare: (url: string) => string,
): string {
  let result = '';
  let index = 0;

  while (index < text.length) {
    if (text[index] === '<') {
      const close = text.indexOf('>', index + 1);
      if (close !== -1) {
        const inner = text.slice(index + 1, close);
        const pipe = inner.indexOf('|');
        if (pipe !== -1) {
          const url = inner.slice(0, pipe);
          const label = inner.slice(pipe + 1);
          if (isSlackLinkScheme(url) && label.length > 0) {
            result += onMarkdown(url, label);
            index = close + 1;
            continue;
          }
        } else if (isSlackLinkScheme(inner)) {
          result += onBare(inner);
          index = close + 1;
          continue;
        }
      }
    }

    result += text[index];
    index += 1;
  }

  return result;
}

function forEachSlackMarkdownLink(
  text: string,
  onMatch: (url: string, label: string) => void,
): void {
  let index = 0;
  while (index < text.length) {
    if (text[index] === '<') {
      const close = text.indexOf('>', index + 1);
      if (close !== -1) {
        const inner = text.slice(index + 1, close);
        const pipe = inner.indexOf('|');
        if (pipe !== -1) {
          const url = inner.slice(0, pipe);
          const label = inner.slice(pipe + 1);
          if (isSlackLinkScheme(url) && label.length > 0) {
            onMatch(url, label);
          }
        }
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }
}

const FORWARDED_IMAGE_URL_FIELDS = [
  'url_private_download',
  'url_private',
  'image_url',
  'thumb_url',
  'thumb_1024',
  'thumb_960',
  'thumb_720',
  'thumb_480',
  'thumb_360',
  'thumb_160',
] as const;

type SlackBlockLink = {
  url: string;
  text?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function getNumberField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];

  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  return undefined;
}

function getFirstStringField(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = getStringField(record, field);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function truncateForwardedMessageText(text: string): string {
  if (text.length <= MAX_FORWARDED_MESSAGE_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_FORWARDED_MESSAGE_TEXT_LENGTH)}... [truncated]`;
}

function normalizeForwardedMessageText(text: string): string {
  return truncateForwardedMessageText(text.replace(/\r\n?/g, '\n').trim());
}

function normalizeSlackLinkText(text: string | undefined): string | undefined {
  const normalized = text
    ?.replace(/\r\n?/g, '\n')
    .replace(/^[*_~]+|[*_~]+$/g, '')
    .trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function decodeSlackEntity(text: string): string {
  return text.replace(/&(?:amp|lt|gt);/g, (entity) => {
    switch (entity.slice(1, -1)) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      default:
        return entity;
    }
  });
}

function normalizeSlackBlockText(text: string): string {
  return replaceSlackLinks(
    decodeSlackEntity(text),
    (_url, label) => decodeSlackEntity(label),
    (url) => decodeSlackEntity(url),
  )
    .replace(/\r\n?/g, '\n')
    .trim();
}

type SlackBlockTextComparison = {
  text: string;
  linkTargets: string[];
};

function normalizeSlackBlockTextForComparison(
  text: string,
): SlackBlockTextComparison {
  const linkTargets = new Set<string>();
  replaceSlackLinks(
    decodeSlackEntity(text),
    (url) => {
      linkTargets.add(decodeSlackEntity(url));
      return '';
    },
    (url) => {
      linkTargets.add(decodeSlackEntity(url));
      return '';
    },
  );

  const normalizedText = normalizeSlackBlockText(text)
    .replace(
      /\[([^\]]+)\]\(<?((?:https?:\/\/|mailto:)[^)\s>]+)>?\)/g,
      (_match, label: string, url: string) => {
        linkTargets.add(decodeSlackEntity(url));
        return label;
      },
    )
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  for (const match of normalizedText.matchAll(/(?:https?:\/\/|mailto:)\S+/g)) {
    linkTargets.add(match[0]);
  }

  const textWithoutLinks = normalizedText
    .replace(/(?:https?:\/\/|mailto:)\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    text: textWithoutLinks || normalizedText,
    linkTargets: [...linkTargets].sort(),
  };
}

function hasAdditionalSlackBlockLink(
  blockText: SlackBlockTextComparison,
  existingText: SlackBlockTextComparison,
): boolean {
  return blockText.linkTargets.some(
    (target) => !existingText.linkTargets.includes(target),
  );
}

function appendUniqueSlackBlockText(
  parts: string[],
  seenParts: Set<string>,
  text: string,
): void {
  const normalized = normalizeSlackBlockText(text);

  if (!normalized || seenParts.has(normalized)) {
    return;
  }

  seenParts.add(normalized);
  parts.push(normalized);
}

function appendUniqueSlackBlockLink(
  links: SlackBlockLink[],
  seenKeys: Set<string>,
  link: SlackBlockLink,
): void {
  const normalizedLink: SlackBlockLink = {
    url: decodeSlackEntity(link.url),
    text: link.text ? decodeSlackEntity(link.text) : undefined,
  };
  const key = `${normalizedLink.url}\n${normalizedLink.text ?? ''}`;

  if (seenKeys.has(key)) {
    return;
  }

  seenKeys.add(key);
  links.push(normalizedLink);
}

function collectSlackMarkdownLinks(
  text: string,
  links: SlackBlockLink[],
  seenKeys: Set<string>,
): void {
  forEachSlackMarkdownLink(text, (url, label) => {
    appendUniqueSlackBlockLink(links, seenKeys, {
      url,
      text: normalizeSlackLinkText(label),
    });
  });
}

function getSlackTextObjectText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return typeof value.text === 'string' ? value.text : undefined;
}

function extractBlockText(
  blocks: unknown,
  parts: string[],
  seenParts: Set<string>,
): void {
  if (!Array.isArray(blocks)) {
    return;
  }

  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }

    switch (getStringField(block, 'type')) {
      case 'section':
      case 'header':
        appendUniqueSlackBlockText(
          parts,
          seenParts,
          getSlackTextObjectText(block.text) ?? '',
        );
        break;
      case 'context': {
        const elements = Array.isArray(block.elements) ? block.elements : [];

        for (const element of elements) {
          if (!isRecord(element)) {
            continue;
          }

          const elementType = getStringField(element, 'type');
          if (
            (elementType === 'mrkdwn' || elementType === 'plain_text') &&
            typeof element.text === 'string'
          ) {
            appendUniqueSlackBlockText(parts, seenParts, element.text);
          }
        }

        break;
      }
      case 'rich_text':
        appendUniqueSlackBlockText(
          parts,
          seenParts,
          extractPlainTextFromBlocks([block]) ?? '',
        );
        break;
      default:
        break;
    }
  }
}

function extractBlockLinks(
  blocks: unknown,
  links: SlackBlockLink[],
  seenKeys: Set<string>,
): void {
  if (!Array.isArray(blocks)) {
    return;
  }

  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }

    switch (getStringField(block, 'type')) {
      case 'section': {
        const text = getSlackTextObjectText(block.text);
        if (text) {
          collectSlackMarkdownLinks(text, links, seenKeys);
        }
        break;
      }
      case 'context': {
        const elements = Array.isArray(block.elements) ? block.elements : [];

        for (const element of elements) {
          if (
            !isRecord(element) ||
            getStringField(element, 'type') !== 'mrkdwn' ||
            typeof element.text !== 'string'
          ) {
            continue;
          }

          collectSlackMarkdownLinks(element.text, links, seenKeys);
        }

        break;
      }
      case 'rich_text': {
        const sections = Array.isArray(block.elements) ? block.elements : [];

        for (const section of sections) {
          if (
            !isRecord(section) ||
            getStringField(section, 'type') !== 'rich_text_section'
          ) {
            continue;
          }

          const elements = Array.isArray(section.elements)
            ? section.elements
            : [];

          for (const element of elements) {
            if (!isRecord(element)) {
              continue;
            }

            const url = getStringField(element, 'url');
            if (getStringField(element, 'type') === 'link' && url) {
              appendUniqueSlackBlockLink(links, seenKeys, {
                url,
                text: normalizeSlackLinkText(getStringField(element, 'text')),
              });
            }
          }
        }

        break;
      }
      default:
        break;
    }
  }
}

function extractPlainTextFromRichTextElement(element: unknown): string {
  if (!isRecord(element)) {
    return '';
  }

  const elementType = getStringField(element, 'type');

  switch (elementType) {
    case 'text':
      return typeof element.text === 'string' ? element.text : '';
    case 'emoji':
      return getStringField(element, 'name')
        ? `:${getStringField(element, 'name')}:`
        : '';
    case 'user':
      return getStringField(element, 'user_id')
        ? `<@${getStringField(element, 'user_id')}>`
        : '';
    case 'channel':
      return getStringField(element, 'channel_id')
        ? `<#${getStringField(element, 'channel_id')}>`
        : '';
    case 'link':
      return (
        getStringField(element, 'text') ?? getStringField(element, 'url') ?? ''
      );
    default:
      break;
  }

  const childElements = Array.isArray(element.elements) ? element.elements : [];

  if (childElements.length === 0) {
    return '';
  }

  const separator =
    elementType === 'rich_text_list' ||
    elementType === 'rich_text_preformatted' ||
    elementType === 'rich_text_quote'
      ? '\n'
      : '';

  return childElements
    .map((child) => extractPlainTextFromRichTextElement(child))
    .filter((part) => part.length > 0)
    .join(separator);
}

function extractPlainTextFromBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) {
    return undefined;
  }

  const text = blocks
    .map((block) => {
      if (!isRecord(block)) {
        return '';
      }

      if (typeof block.text === 'string') {
        return block.text;
      }

      if (isRecord(block.text) && typeof block.text.text === 'string') {
        return block.text.text;
      }

      const elements = Array.isArray(block.elements) ? block.elements : [];
      return elements
        .map((element) => extractPlainTextFromRichTextElement(element))
        .filter((part) => part.length > 0)
        .join('\n');
    })
    .filter((part) => part.length > 0)
    .join('\n');

  return text.trim().length > 0
    ? normalizeForwardedMessageText(text)
    : undefined;
}

function extractTextFromSlackMessageBlocks(
  attachment: Record<string, unknown>,
): string | undefined {
  const fromBlocks = extractPlainTextFromBlocks(attachment.blocks);

  if (fromBlocks) {
    return fromBlocks;
  }

  const messageBlocks = Array.isArray(attachment.message_blocks)
    ? attachment.message_blocks
    : [];

  const text = messageBlocks
    .map((messageBlock) => {
      if (!isRecord(messageBlock) || !isRecord(messageBlock.message)) {
        return '';
      }

      return extractPlainTextFromBlocks(messageBlock.message.blocks) ?? '';
    })
    .filter((part) => part.length > 0)
    .join('\n');

  return text.trim().length > 0
    ? normalizeForwardedMessageText(text)
    : undefined;
}

function isForwardedSlackMessageAttachment(
  attachment: Record<string, unknown>,
): boolean {
  return (
    attachment.is_share === true ||
    attachment.is_msg_unfurl === true ||
    getStringField(attachment, 'footer') === 'Slack Conversation' ||
    Boolean(getStringField(attachment, 'from_url')?.includes('/archives/')) ||
    Array.isArray(attachment.message_blocks)
  );
}

function getImageFiletypeFromUrl(url: string): string | undefined {
  let pathname = url;

  try {
    pathname = new URL(url).pathname;
  } catch {
    // Keep the raw value for simple extension detection below.
  }

  const extension = pathname
    .split('/')
    .at(-1)
    ?.split('?')[0]
    ?.split('#')[0]
    ?.split('.')
    .at(-1)
    ?.toLowerCase();

  return extension &&
    ['gif', 'heic', 'jpeg', 'jpg', 'png', 'webp'].includes(extension)
    ? extension
    : undefined;
}

function getImageMimetypeFromFiletype(filetype: string): string | undefined {
  switch (filetype.toLowerCase()) {
    case 'gif':
      return 'image/gif';
    case 'heic':
      return 'image/heic';
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return undefined;
  }
}

function getFiletypeFromImageMimetype(mimetype: string): string {
  const subtype = mimetype.split('/')[1]?.toLowerCase();

  return subtype === 'jpeg' ? 'jpg' : subtype || 'image';
}

function inferSlackImageMimetype({
  record,
  url,
  allowImageFieldFallback,
}: {
  record: Record<string, unknown>;
  url: string;
  allowImageFieldFallback: boolean;
}): string | undefined {
  const explicitMimetype =
    getStringField(record, 'mimetype') ?? getStringField(record, 'mime_type');

  if (explicitMimetype) {
    return explicitMimetype.startsWith('image/') ? explicitMimetype : undefined;
  }

  const explicitFiletype =
    getStringField(record, 'filetype') ?? getStringField(record, 'file_type');

  if (explicitFiletype) {
    return getImageMimetypeFromFiletype(explicitFiletype);
  }

  const urlFiletype = getImageFiletypeFromUrl(url);

  if (urlFiletype) {
    return getImageMimetypeFromFiletype(urlFiletype);
  }

  return allowImageFieldFallback ? 'image/jpeg' : undefined;
}

function hashForwardedImageUrl(url: string): string {
  let hash = 0;

  for (let index = 0; index < url.length; index += 1) {
    hash = (hash * 31 + url.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function coerceSlackImageFile(
  record: Record<string, unknown>,
): SlackFile | undefined {
  const url = getFirstStringField(record, FORWARDED_IMAGE_URL_FIELDS);

  if (!url) {
    return undefined;
  }

  const selectedField = FORWARDED_IMAGE_URL_FIELDS.find(
    (field) => getStringField(record, field) === url,
  );
  const mimetype = inferSlackImageMimetype({
    record,
    url,
    allowImageFieldFallback: Boolean(
      selectedField &&
      !['url_private_download', 'url_private'].includes(selectedField),
    ),
  });

  if (!mimetype) {
    return undefined;
  }

  const filetype =
    getStringField(record, 'filetype') ??
    getStringField(record, 'file_type') ??
    getImageFiletypeFromUrl(url) ??
    getFiletypeFromImageMimetype(mimetype);
  const name =
    getStringField(record, 'name') ??
    getStringField(record, 'title') ??
    `forwarded-image.${filetype}`;

  return {
    id:
      getStringField(record, 'id') ??
      getStringField(record, 'file_id') ??
      `forwarded-${hashForwardedImageUrl(url)}`,
    name,
    mimetype,
    filetype,
    url_private: getStringField(record, 'url_private') ?? url,
    url_private_download:
      getStringField(record, 'url_private_download') ??
      getStringField(record, 'url_private') ??
      url,
    size:
      getNumberField(record, 'size') ??
      getNumberField(record, 'image_bytes') ??
      0,
  };
}

function getSlackFileUrls(file: SlackFile): string[] {
  return [file.url_private_download, file.url_private].filter(
    (url, index, urls): url is string =>
      typeof url === 'string' && url.length > 0 && urls.indexOf(url) === index,
  );
}

function getSlackFileDedupeKeys(file: SlackFile): string[] {
  return [file.id, ...getSlackFileUrls(file)].filter(
    (key, index, keys): key is string =>
      typeof key === 'string' && key.length > 0 && keys.indexOf(key) === index,
  );
}

function isSyntheticForwardedFileId(fileId: string): boolean {
  return fileId.startsWith('forwarded-');
}

function slackFileUrlContainsFileId(url: string, fileId: string): boolean {
  if (isSyntheticForwardedFileId(fileId)) {
    return false;
  }

  try {
    return new URL(url).pathname.split('/').includes(fileId);
  } catch {
    return url.split('/').includes(fileId);
  }
}

function areLikelySameSlackImageFile(
  first: SlackFile,
  second: SlackFile,
): boolean {
  if (first.id === second.id) {
    return true;
  }

  const firstUrls = getSlackFileUrls(first);
  const secondUrls = getSlackFileUrls(second);

  if (firstUrls.some((url) => secondUrls.includes(url))) {
    return true;
  }

  return (
    secondUrls.some((url) => slackFileUrlContainsFileId(url, first.id)) ||
    firstUrls.some((url) => slackFileUrlContainsFileId(url, second.id))
  );
}

function appendUniqueSlackFile(
  files: SlackFile[],
  seenKeys: Set<string>,
  file: SlackFile,
): void {
  const dedupeKeys = getSlackFileDedupeKeys(file);

  if (
    dedupeKeys.some((dedupeKey) => seenKeys.has(dedupeKey)) ||
    files.some((existingFile) =>
      areLikelySameSlackImageFile(existingFile, file),
    )
  ) {
    return;
  }

  for (const dedupeKey of dedupeKeys) {
    seenKeys.add(dedupeKey);
  }

  files.push(file);
}

function collectNestedForwardedSlackImageFilesFromValue(
  value: unknown,
  files: SlackFile[],
  seenKeys: Set<string>,
  depth = 0,
): void {
  if (depth > 5) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedForwardedSlackImageFilesFromValue(
        item,
        files,
        seenKeys,
        depth + 1,
      );
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (Array.isArray(value.files)) {
    for (const file of value.files) {
      if (!isRecord(file)) {
        continue;
      }

      const imageFile = coerceSlackImageFile(file);

      if (imageFile) {
        appendUniqueSlackFile(files, seenKeys, imageFile);
      }
    }
  }

  if (Array.isArray(value.message_blocks)) {
    for (const messageBlock of value.message_blocks) {
      if (!isRecord(messageBlock)) {
        continue;
      }

      collectNestedForwardedSlackImageFilesFromValue(
        messageBlock.message,
        files,
        seenKeys,
        depth + 1,
      );
    }
  }

  collectNestedForwardedSlackImageFilesFromValue(
    value.message,
    files,
    seenKeys,
    depth + 1,
  );
  collectNestedForwardedSlackImageFilesFromValue(
    value.attachments,
    files,
    seenKeys,
    depth + 1,
  );
}

function collectPreviewForwardedSlackImageFilesFromValue(
  value: unknown,
  files: SlackFile[],
  seenKeys: Set<string>,
  depth = 0,
): void {
  if (depth > 5) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPreviewForwardedSlackImageFilesFromValue(
        item,
        files,
        seenKeys,
        depth + 1,
      );
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const directImageFile = coerceSlackImageFile(value);

  if (directImageFile) {
    appendUniqueSlackFile(files, seenKeys, directImageFile);
  }

  if (Array.isArray(value.message_blocks)) {
    for (const messageBlock of value.message_blocks) {
      if (!isRecord(messageBlock)) {
        continue;
      }

      collectPreviewForwardedSlackImageFilesFromValue(
        messageBlock.message,
        files,
        seenKeys,
        depth + 1,
      );
    }
  }

  collectPreviewForwardedSlackImageFilesFromValue(
    value.message,
    files,
    seenKeys,
    depth + 1,
  );
  collectPreviewForwardedSlackImageFilesFromValue(
    value.attachments,
    files,
    seenKeys,
    depth + 1,
  );
}

function formatForwardedSlackMessageAttachment(
  attachment: Record<string, unknown>,
): string | undefined {
  if (!isForwardedSlackMessageAttachment(attachment)) {
    return undefined;
  }

  const forwardedText =
    getStringField(attachment, 'text') ??
    extractTextFromSlackMessageBlocks(attachment) ??
    getStringField(attachment, 'fallback');

  if (!forwardedText) {
    return undefined;
  }

  const lines = ['Forwarded Slack message:'];
  const authorName =
    getStringField(attachment, 'author_name') ??
    getStringField(attachment, 'author_id');
  const channelId = getStringField(attachment, 'channel_id');
  const sourceUrl = getStringField(attachment, 'from_url');

  const contextDetails: string[] = [];

  if (authorName) {
    contextDetails.push(`Author: ${authorName}`);
  }

  if (channelId) {
    contextDetails.push(`Channel: ${channelId}`);
  }

  if (sourceUrl) {
    contextDetails.push(`Source: ${sourceUrl}`);
  }

  if (contextDetails.length > 0) {
    lines.push('Context:');
    lines.push(...contextDetails.map((detail) => `- ${detail}`));
  }

  lines.push('Text:', normalizeForwardedMessageText(forwardedText));

  return lines.join('\n');
}

function formatSlackAttachmentTitleContext(
  attachment: Record<string, unknown>,
): string | undefined {
  if (isForwardedSlackMessageAttachment(attachment)) {
    return undefined;
  }

  const title = getStringField(attachment, 'title');
  const titleLink = getStringField(attachment, 'title_link');

  if (!title && !titleLink) {
    return undefined;
  }

  const text = getStringField(attachment, 'text');
  const fallback = getStringField(attachment, 'fallback');
  const authorName =
    getStringField(attachment, 'author_name') ??
    getStringField(attachment, 'author_id') ??
    getStringField(attachment, 'service_name');
  const lines = ['Slack attachment:'];

  if (authorName) {
    lines.push(`Author: ${authorName}`);
  }

  if (title) {
    lines.push(`Title: ${title}`);
  }

  if (titleLink) {
    lines.push(`URL: ${titleLink}`);
  }

  const body = text ?? fallback;
  if (body && body !== title && body !== titleLink) {
    lines.push('Text:', normalizeForwardedMessageText(body));
  }

  return lines.join('\n');
}

export function formatSlackForwardedMessageContext(
  attachments?: unknown[],
): string | undefined {
  const formattedAttachments = (attachments ?? [])
    .map((attachment) =>
      isRecord(attachment)
        ? formatForwardedSlackMessageAttachment(attachment)
        : undefined,
    )
    .filter((attachment): attachment is string => Boolean(attachment));

  if (formattedAttachments.length === 0) {
    return undefined;
  }

  return formattedAttachments.join('\n\n');
}

export function formatSlackAttachmentTitleContexts(
  attachments?: unknown[],
): string | undefined {
  const formattedAttachments = (attachments ?? [])
    .map((attachment) =>
      isRecord(attachment)
        ? formatSlackAttachmentTitleContext(attachment)
        : undefined,
    )
    .filter((attachment): attachment is string => Boolean(attachment));

  if (formattedAttachments.length === 0) {
    return undefined;
  }

  return formattedAttachments.join('\n\n');
}

export function formatSlackBlockLinkContext(
  blocks?: unknown[],
): string | undefined {
  const links: SlackBlockLink[] = [];
  const seenKeys = new Set<string>();

  extractBlockLinks(blocks, links, seenKeys);

  if (links.length === 0) {
    return undefined;
  }

  return [
    'Slack block links:',
    ...links.map((link) =>
      link.text && link.text !== link.url
        ? `- ${link.text}: ${link.url}`
        : `- ${link.url}`,
    ),
  ].join('\n');
}

export function formatSlackBlockTextContext(
  blocks?: unknown[],
  existingText = '',
): string | undefined {
  const parts: string[] = [];
  const seenParts = new Set<string>();

  extractBlockText(blocks, parts, seenParts);

  const normalizedExistingText = normalizeSlackBlockText(existingText);
  const comparableExistingText =
    normalizeSlackBlockTextForComparison(existingText);
  const uniqueParts = parts.filter((part) => {
    const comparablePart = normalizeSlackBlockTextForComparison(part);
    const hasAdditionalLink = hasAdditionalSlackBlockLink(
      comparablePart,
      comparableExistingText,
    );

    return (
      part !== normalizedExistingText &&
      (hasAdditionalLink ||
        (comparablePart.text !== comparableExistingText.text &&
          !comparableExistingText.text.includes(comparablePart.text)))
    );
  });

  if (uniqueParts.length === 0) {
    return undefined;
  }

  return ['Slack block text:', ...uniqueParts].join('\n');
}

export function extractSlackForwardedMessageFiles(
  attachments?: unknown[],
): SlackFile[] {
  const files: SlackFile[] = [];
  const seenKeys = new Set<string>();

  for (const attachment of attachments ?? []) {
    if (
      !isRecord(attachment) ||
      !isForwardedSlackMessageAttachment(attachment)
    ) {
      continue;
    }

    const nestedFiles: SlackFile[] = [];
    const nestedSeenKeys = new Set<string>();
    collectNestedForwardedSlackImageFilesFromValue(
      attachment,
      nestedFiles,
      nestedSeenKeys,
    );

    for (const file of nestedFiles) {
      appendUniqueSlackFile(files, seenKeys, file);
    }

    collectPreviewForwardedSlackImageFilesFromValue(
      attachment,
      files,
      seenKeys,
    );
  }

  return files;
}

export function appendSlackForwardedMessageFiles(
  files: SlackFile[] | undefined,
  attachments?: unknown[],
): SlackFile[] | undefined {
  const forwardedFiles = extractSlackForwardedMessageFiles(attachments);

  if (!files?.length && forwardedFiles.length === 0) {
    return undefined;
  }

  const mergedFiles: SlackFile[] = [];
  const seenKeys = new Set<string>();

  for (const file of [...(files ?? []), ...forwardedFiles]) {
    appendUniqueSlackFile(mergedFiles, seenKeys, file);
  }

  return mergedFiles;
}

export function appendSlackForwardedMessageContext(
  text: string,
  attachments?: unknown[],
): string {
  const forwardedContext = formatSlackForwardedMessageContext(attachments);

  if (!forwardedContext) {
    return text;
  }

  const normalizedText = text.trim();
  return normalizedText
    ? `${normalizedText}\n\n${forwardedContext}`
    : forwardedContext;
}

export function appendSlackAttachmentContext(
  text: string,
  attachments?: unknown[],
  blocks?: unknown[],
): string {
  const textWithForwardedContext = appendSlackForwardedMessageContext(
    text,
    attachments,
  );
  const attachmentTitleContext =
    formatSlackAttachmentTitleContexts(attachments);
  const blockTextContext = formatSlackBlockTextContext(
    blocks,
    textWithForwardedContext,
  );
  const blockLinkContext = formatSlackBlockLinkContext(blocks);
  const additionalContexts = [
    attachmentTitleContext,
    blockTextContext,
    blockLinkContext,
  ].filter((context): context is string => Boolean(context));

  if (additionalContexts.length === 0) {
    return textWithForwardedContext;
  }

  const normalizedText = textWithForwardedContext.trim();
  return normalizedText
    ? `${normalizedText}\n\n${additionalContexts.join('\n\n')}`
    : additionalContexts.join('\n\n');
}
