import { CommandPalette } from '@/components/layout/CommandPalette';
import { CommandPaletteProvider } from '@/components/layout/CommandPaletteContext';
import { TaskLaunchConfigProvider } from '@/components/tasks/TaskLaunchConfig';
import { resolveTaskLaunchConfig } from '@/lib/server/task-launch-config';

import { SandboxShell } from './SandboxShell';

interface SandboxLayoutProps {
  children: React.ReactNode;
}

export default async function SandboxLayout({ children }: SandboxLayoutProps) {
  const taskLaunchConfig = await resolveTaskLaunchConfig();

  return (
    <TaskLaunchConfigProvider value={taskLaunchConfig}>
      <CommandPaletteProvider>
        <SandboxShell>{children}</SandboxShell>
        <CommandPalette />
      </CommandPaletteProvider>
    </TaskLaunchConfigProvider>
  );
}
