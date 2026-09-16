import { SHARED_DESKTOP_NAMED_PORT } from '@roomote/types';

/**
 * Shared Desktop URLs grant input control, so the submitted preview URL must
 * be this run's own desktop host (`<taskId>-shared-desktop[.-]...`) rather
 * than an arbitrary preview host the caller knows about.
 */
export function isTaskSharedDesktopHost(
  previewUrl: URL,
  taskId: string,
): boolean {
  const desktopSlug = SHARED_DESKTOP_NAMED_PORT.name
    .toLowerCase()
    .replace(/_/g, '-');
  const expectedPrefix = `${taskId}-${desktopSlug}`;
  const [firstLabel] = previewUrl.hostname.split('.');

  return (
    firstLabel === expectedPrefix ||
    (firstLabel?.startsWith(`${expectedPrefix}-`) ?? false)
  );
}
