const TEXT_ATTACHMENT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'json',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'cxx',
  'cc',
  'hpp',
  'sql',
  'log',
  'conf',
  'config',
  'ini',
  'env',
  'sh',
  'bash',
  'zsh',
  'toml',
  'properties',
  'csv',
  'tsv',
] as const;

const SPREADSHEET_ATTACHMENT_EXTENSIONS = ['xlsx', 'xls'] as const;
const DOCUMENT_ATTACHMENT_EXTENSIONS = ['pdf', 'docx'] as const;
const PRESENTATION_ATTACHMENT_EXTENSIONS = ['pptx'] as const;
const IMAGE_ATTACHMENT_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
] as const;
const PROMPT_IMAGE_ATTACHMENT_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
] as const;

export const ROOMOTE_SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS = [
  ...TEXT_ATTACHMENT_EXTENSIONS,
];
export const ROOMOTE_SUPPORTED_SPREADSHEET_ATTACHMENT_EXTENSIONS = [
  ...SPREADSHEET_ATTACHMENT_EXTENSIONS,
];
export const ROOMOTE_SUPPORTED_DOCUMENT_ATTACHMENT_EXTENSIONS = [
  ...DOCUMENT_ATTACHMENT_EXTENSIONS,
];
export const ROOMOTE_SUPPORTED_PRESENTATION_ATTACHMENT_EXTENSIONS = [
  ...PRESENTATION_ATTACHMENT_EXTENSIONS,
];
export const ROOMOTE_SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS = [
  ...IMAGE_ATTACHMENT_EXTENSIONS,
];

export const ROOMOTE_SUPPORTED_FILE_ATTACHMENT_EXTENSIONS = [
  ...ROOMOTE_SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS,
  ...ROOMOTE_SUPPORTED_SPREADSHEET_ATTACHMENT_EXTENSIONS,
  ...ROOMOTE_SUPPORTED_DOCUMENT_ATTACHMENT_EXTENSIONS,
  ...ROOMOTE_SUPPORTED_PRESENTATION_ATTACHMENT_EXTENSIONS,
  ...ROOMOTE_SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS,
];

const TEXT_ATTACHMENT_EXTENSION_SET: ReadonlySet<string> = new Set(
  ROOMOTE_SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS,
);
const SPREADSHEET_ATTACHMENT_EXTENSION_SET: ReadonlySet<string> = new Set(
  ROOMOTE_SUPPORTED_SPREADSHEET_ATTACHMENT_EXTENSIONS,
);
const DOCUMENT_ATTACHMENT_EXTENSION_SET: ReadonlySet<string> = new Set(
  ROOMOTE_SUPPORTED_DOCUMENT_ATTACHMENT_EXTENSIONS,
);
const PRESENTATION_ATTACHMENT_EXTENSION_SET: ReadonlySet<string> = new Set(
  ROOMOTE_SUPPORTED_PRESENTATION_ATTACHMENT_EXTENSIONS,
);
const PROMPT_IMAGE_ATTACHMENT_EXTENSION_SET: ReadonlySet<string> = new Set(
  PROMPT_IMAGE_ATTACHMENT_EXTENSIONS,
);

const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/toml',
  'application/x-sh',
  'application/x-yaml',
  'application/xhtml+xml',
  'application/xml',
  'image/svg+xml',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/x-python',
  'text/x-ruby',
  'text/x-sql',
  'text/xml',
]);

const SPREADSHEET_ATTACHMENT_MIME_TYPES = new Set([
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const DOCUMENT_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const PRESENTATION_ATTACHMENT_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const IMAGE_ATTACHMENT_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/svg+xml',
  'image/webp',
]);
const PROMPT_IMAGE_ATTACHMENT_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

export const ROOMOTE_FILE_ATTACHMENT_ACCEPT = Array.from(
  new Set([
    'text/*',
    ...Array.from(TEXT_ATTACHMENT_MIME_TYPES),
    ...Array.from(SPREADSHEET_ATTACHMENT_MIME_TYPES),
    ...Array.from(DOCUMENT_ATTACHMENT_MIME_TYPES),
    ...Array.from(PRESENTATION_ATTACHMENT_MIME_TYPES),
    ...Array.from(IMAGE_ATTACHMENT_MIME_TYPES),
    ...ROOMOTE_SUPPORTED_FILE_ATTACHMENT_EXTENSIONS.map(
      (extension) => `.${extension}`,
    ),
  ]),
).join(',');

function getLowercaseExtension(filename: string | undefined): string | null {
  if (!filename) {
    return null;
  }

  const trimmed = filename.trim();
  const lastDotIndex = trimmed.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === trimmed.length - 1) {
    return null;
  }

  return trimmed.slice(lastDotIndex + 1).toLowerCase();
}

function normalizeMimeType(mimeType: string | undefined): string | null {
  const trimmed = mimeType?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

export function isRoomoteImageAttachment(input: {
  filename?: string;
  mimeType?: string;
}): boolean {
  const normalizedMimeType = normalizeMimeType(input.mimeType);
  // SVG is supported as an attachment, but not as inline prompt image input.
  // Downstream model paths reject it, so keep it eligible for text extraction.
  if (
    normalizedMimeType &&
    PROMPT_IMAGE_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)
  ) {
    return true;
  }

  const extension = getLowercaseExtension(input.filename);
  return (
    extension !== null && PROMPT_IMAGE_ATTACHMENT_EXTENSION_SET.has(extension)
  );
}

export function isRoomoteTextExtractableAttachment(input: {
  filename?: string;
  mimeType?: string;
}): boolean {
  if (isRoomoteImageAttachment(input)) {
    return false;
  }

  const normalizedMimeType = normalizeMimeType(input.mimeType);

  if (normalizedMimeType?.startsWith('text/')) {
    return true;
  }

  if (
    normalizedMimeType &&
    (TEXT_ATTACHMENT_MIME_TYPES.has(normalizedMimeType) ||
      normalizedMimeType.endsWith('+json') ||
      normalizedMimeType.endsWith('+xml') ||
      SPREADSHEET_ATTACHMENT_MIME_TYPES.has(normalizedMimeType) ||
      DOCUMENT_ATTACHMENT_MIME_TYPES.has(normalizedMimeType) ||
      PRESENTATION_ATTACHMENT_MIME_TYPES.has(normalizedMimeType))
  ) {
    return true;
  }

  const extension = getLowercaseExtension(input.filename);
  if (!extension) {
    return false;
  }

  return (
    TEXT_ATTACHMENT_EXTENSION_SET.has(extension) ||
    SPREADSHEET_ATTACHMENT_EXTENSION_SET.has(extension) ||
    DOCUMENT_ATTACHMENT_EXTENSION_SET.has(extension) ||
    PRESENTATION_ATTACHMENT_EXTENSION_SET.has(extension)
  );
}

export function appendAttachmentTextsToPromptText(input: {
  text: string;
  attachmentTexts?: string[];
}): string {
  const baseText = input.text.trim();
  const attachmentTexts = (input.attachmentTexts ?? []).filter(
    (attachmentText) => attachmentText.trim().length > 0,
  );

  if (attachmentTexts.length === 0) {
    return baseText;
  }

  return [baseText, ...attachmentTexts].filter(Boolean).join('\n\n');
}
