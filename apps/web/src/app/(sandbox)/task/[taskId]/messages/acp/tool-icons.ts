import {
  type LucideIcon,
  Brain,
  Bot,
  FileIcon,
  FolderIcon,
  GalleryVerticalEnd,
  GitPullRequest,
  HardDriveUpload,
  ListChecks,
  MessageSquareText,
  MessagesSquare,
  RoomoteR,
  Search,
  SquarePen,
  Target,
  Terminal,
  TriangleAlert,
  VectorSquare,
  Video,
  Wrench,
  Zap,
} from '@/components/system';

import type { ToolIconKey } from './tool-presentation';

export function toolIconForKey(key: ToolIconKey): LucideIcon {
  if (key === 'terminal') return Terminal;
  if (key === 'file') return FileIcon;
  if (key === 'folder') return FolderIcon;
  if (key === 'search') return Search;
  if (key === 'edit') return SquarePen;
  if (key === 'bot') return Bot;
  if (key === 'task') return Zap;
  if (key === 'message') return MessageSquareText;
  if (key === 'memory') return Brain;
  if (key === 'artifact') return HardDriveUpload;
  if (key === 'widget') return GalleryVerticalEnd;
  if (key === 'roomote') return RoomoteR;
  if (key === 'video') return Video;
  if (key === 'target') return Target;
  if (key === 'list-checks') return ListChecks;
  if (key === 'pull-request') return GitPullRequest;
  if (key === 'environment') return VectorSquare;
  if (key === 'alert') return TriangleAlert;
  if (key === 'messages') return MessagesSquare;
  return Wrench;
}
