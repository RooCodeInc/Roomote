'use client';

import { createContext, useContext } from 'react';
import type { RunStatus } from '@roomote/types';

export const OpenSessionTaskPanelContext = createContext<
  ((taskId: string) => void) | null
>(null);
export const OpenSessionTasksPanelContext = createContext<(() => void) | null>(
  null,
);
/** Artifact the Session workspace can show in its side-panel viewer. */
export type SessionArtifactViewerSelection = {
  owner: { taskId: string } | { sessionId: string };
  path: string;
  version?: number;
};
export const OpenSessionArtifactViewerContext = createContext<
  ((selection: SessionArtifactViewerSelection) => void) | null
>(null);
export const SessionRunningTaskCountContext = createContext(0);
/** Fingerprint of the session's delegated-task state; see
 * `computeTaskStateRevision`. Drives composer-suggestion refreshes. */
export const SessionTaskStateRevisionContext = createContext('');

export interface SessionReviewTask {
  taskId: string;
  workflow: string;
  latestRun: { status: RunStatus; taskPhase?: string | null } | null;
  pullRequests: Array<{
    url: string;
    number: number | null;
    repository: string | null;
    status: string | null;
  }>;
}
export const SessionReviewTasksContext = createContext<SessionReviewTask[]>([]);

export function useOpenSessionTaskPanel() {
  return useContext(OpenSessionTaskPanelContext);
}

export function useOpenSessionTasksPanel() {
  return useContext(OpenSessionTasksPanelContext);
}

export function useOpenSessionArtifactViewer() {
  return useContext(OpenSessionArtifactViewerContext);
}

export function useSessionRunningTaskCount() {
  return useContext(SessionRunningTaskCountContext);
}

export function useSessionTaskStateRevision() {
  return useContext(SessionTaskStateRevisionContext);
}
