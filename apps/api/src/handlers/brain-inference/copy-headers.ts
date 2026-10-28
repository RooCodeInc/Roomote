export function copyAllowedHeaders(
  source: Headers,
  denylist: Set<string>,
): Headers {
  const headers = new Headers();

  for (const [name, value] of source.entries()) {
    if (!denylist.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  return headers;
}
