export function isHtmlArtifact(contentType: string, path: string): boolean {
  const normalizedContentType =
    contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = path.split('.').pop()?.toLowerCase();

  return (
    normalizedContentType === 'text/html' ||
    normalizedContentType === 'application/xhtml+xml' ||
    extension === 'html' ||
    extension === 'htm' ||
    extension === 'xhtml'
  );
}

export function isMarkdownArtifact(contentType: string, path: string): boolean {
  const normalizedContentType =
    contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = path.split('.').pop()?.toLowerCase();

  return (
    !isHtmlArtifact(contentType, path) &&
    (normalizedContentType.includes('markdown') || extension === 'md')
  );
}
