const PROMPT_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const PROMPT_IMAGE_EXTENSION_MIME_TYPES = new Map([
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}

export function normalizePromptImageMimeType(
  contentType: string | undefined,
): string | undefined {
  const normalized = cleanOptionalString(contentType)?.toLowerCase();

  if (!normalized) {
    return undefined;
  }

  const [mimeType] = normalized.split(';');

  if (mimeType === 'image/jpg') {
    return 'image/jpeg';
  }

  return mimeType && PROMPT_IMAGE_MIME_TYPES.has(mimeType)
    ? mimeType
    : undefined;
}

export function inferPromptImageMimeTypeFromName(
  name: string | undefined,
): string | undefined {
  const normalizedName = cleanOptionalString(name)?.toLowerCase();
  const extension = normalizedName?.split('.').pop();

  return extension
    ? PROMPT_IMAGE_EXTENSION_MIME_TYPES.get(extension)
    : undefined;
}

export function isGenericImageMimeType(
  contentType: string | undefined,
): boolean {
  const normalized = cleanOptionalString(contentType)?.toLowerCase();
  const [mimeType] = normalized?.split(';') ?? [];

  return mimeType === 'image/*';
}
