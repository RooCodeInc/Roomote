import { redirect } from 'next/navigation';

import { SETTINGS_PATHS } from '@/lib/settings';

export default function Page() {
  redirect(SETTINGS_PATHS.memory);
}
