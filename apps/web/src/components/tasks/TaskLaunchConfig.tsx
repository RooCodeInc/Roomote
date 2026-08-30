'use client';

import { createContext, useContext, type ReactNode } from 'react';

import {
  SETUP_COMPUTE_PROVIDER_CATALOG,
  type ComputeProvider,
} from '@roomote/types';

export type TaskLaunchConfig = {
  defaultComputeProvider: ComputeProvider;
  availableComputeProviders: readonly ComputeProvider[];
};

const DEFAULT_TASK_LAUNCH_CONFIG: TaskLaunchConfig = {
  defaultComputeProvider: 'docker',
  availableComputeProviders: SETUP_COMPUTE_PROVIDER_CATALOG.map(
    ({ provider }) => provider,
  ),
};

const TaskLaunchConfigContext = createContext<TaskLaunchConfig>(
  DEFAULT_TASK_LAUNCH_CONFIG,
);

export function TaskLaunchConfigProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: TaskLaunchConfig;
}) {
  return (
    <TaskLaunchConfigContext.Provider value={value}>
      {children}
    </TaskLaunchConfigContext.Provider>
  );
}

export function useTaskLaunchConfig(): TaskLaunchConfig {
  return useContext(TaskLaunchConfigContext);
}
