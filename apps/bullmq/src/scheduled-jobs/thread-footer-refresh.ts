import { refreshCurrentThreadFooters } from '@roomote/sdk/server';

export async function threadFooterRefreshJob(): Promise<void> {
  await refreshCurrentThreadFooters();
}
