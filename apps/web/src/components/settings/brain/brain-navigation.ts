export function buildMemoryHref(
  pathname: string,
  searchParams: { toString(): string },
  slug: string | null,
): string {
  const params = new URLSearchParams(searchParams.toString());

  if (slug) {
    params.set('memory', slug);
  } else {
    params.delete('memory');
  }

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
