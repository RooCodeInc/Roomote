import type { CloudJobDetail } from '@/lib/server/cloud-jobs';

export interface SidebarActionBaseProps {
  taskId: string;
  cloudJob: CloudJobDetail | null | undefined;
}

export interface OverflowMenuProps extends SidebarActionBaseProps {
  disabled?: boolean;
  onDeleteSuccess?: () => void;
}

/** Minimum shape an artifact must have to be groupable by path. */
export interface GroupableArtifact {
  path: string;
  version: number;
  createdAt: Date | string;
}

export interface ArtifactGroup<
  T extends GroupableArtifact = GroupableArtifact,
> {
  path: string;
  latest: T;
  olderVersions: T[];
}
