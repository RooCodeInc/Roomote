import { redirect } from 'next/navigation';

import { SETTINGS_PATHS } from '@/lib/settings';

// Live previews are always enabled; the setup experience now lives in the
// task page's preview pane. Redirect old bookmarks to environment settings.
export default function Page() {
  redirect(SETTINGS_PATHS.environments);
}
