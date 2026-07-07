export function parseDataUriImage(
  input: string,
): { data: string; mimeType: string } | undefined {
  const trimmed = input.trim();
  const dataUriMatch = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed);

  if (!dataUriMatch || !dataUriMatch[1] || !dataUriMatch[2]) {
    return undefined;
  }

  return {
    mimeType: dataUriMatch[1],
    data: dataUriMatch[2],
  };
}

export function isLikelyBase64(value: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length < 16) {
    return false;
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
}

export function imageInputToPromptBlock(
  imageInput: string,
): Record<string, unknown> | undefined {
  const parsedDataUri = parseDataUriImage(imageInput);

  if (parsedDataUri) {
    return {
      type: 'image',
      data: parsedDataUri.data,
      mimeType: parsedDataUri.mimeType,
    };
  }

  if (isLikelyBase64(imageInput)) {
    return { type: 'image', data: imageInput.trim(), mimeType: 'image/png' };
  }

  return undefined;
}
