import { TaskLaunchConfigProvider } from '@/components/tasks/TaskLaunchConfig';
import { resolveTaskLaunchConfig } from '@/lib/server/task-launch-config';

import AuthenticatedLayoutClient from './AuthenticatedLayoutClient';

export const dynamic = 'force-dynamic';

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const taskLaunchConfig = await resolveTaskLaunchConfig();

  return (
    <TaskLaunchConfigProvider value={taskLaunchConfig}>
      <AuthenticatedLayoutClient>{children}</AuthenticatedLayoutClient>
    </TaskLaunchConfigProvider>
  );
}
