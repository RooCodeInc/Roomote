import {
  type LucideIcon,
  Brain,
  Bot,
  FileIcon,
  FolderIcon,
  GalleryVerticalEnd,
  HardDriveUpload,
  MessageSquareText,
  Search,
  SquarePen,
  Terminal,
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
  return Wrench;
}
