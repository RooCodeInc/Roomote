export type TabularArtifactFormat = 'csv' | 'tsv';

function normalizeContentType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function getExtension(path: string): string | undefined {
  return path.split('.').pop()?.toLowerCase();
}

export function getTabularArtifactFormat(
  contentType: string,
  path: string,
): TabularArtifactFormat | null {
  const normalizedContentType = normalizeContentType(contentType);
  const extension = getExtension(path);

  if (
    normalizedContentType === 'text/csv' ||
    normalizedContentType === 'application/csv' ||
    normalizedContentType === 'text/x-csv'
  ) {
    return 'csv';
  }

  if (
    normalizedContentType === 'text/tab-separated-values' ||
    normalizedContentType === 'text/tsv' ||
    normalizedContentType === 'application/tsv'
  ) {
    return 'tsv';
  }

  if (extension === 'csv') return 'csv';
  if (extension === 'tsv' || extension === 'tab') return 'tsv';

  return null;
}

export function isTabularArtifact(contentType: string, path: string): boolean {
  return getTabularArtifactFormat(contentType, path) !== null;
}

export function isHtmlArtifact(contentType: string, path: string): boolean {
  const normalizedContentType = normalizeContentType(contentType);
  const extension = getExtension(path);

  return (
    !isTabularArtifact(contentType, path) &&
    (normalizedContentType === 'text/html' ||
      normalizedContentType === 'application/xhtml+xml' ||
      extension === 'html' ||
      extension === 'htm' ||
      extension === 'xhtml')
  );
}

export function isMarkdownArtifact(contentType: string, path: string): boolean {
  const normalizedContentType = normalizeContentType(contentType);
  const extension = getExtension(path);

  return (
    !isHtmlArtifact(contentType, path) &&
    !isTabularArtifact(contentType, path) &&
    (normalizedContentType.includes('markdown') || extension === 'md')
  );
}
