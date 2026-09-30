'use client';

import type { TaskModelMetadata } from '@roomote/types';

export type EditableRuntimeModelOption = {
  id: string;
  displayName: string;
  family?: string;
  metadata?: TaskModelMetadata | null;
};
