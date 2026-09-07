const MAX_PAGE_TITLE_LENGTH = 60;

export function truncatePageTitle<T extends string | null | undefined>(
  title: T,
): T | string {
  return title && title.length > MAX_PAGE_TITLE_LENGTH
    ? `${title.slice(0, MAX_PAGE_TITLE_LENGTH)}...`
    : title;
}
