export const demoSeedDevelopmentIntegration = {
  id: '00000000-0000-4000-8000-000000000301',
  name: 'Development fixtures',
  url: 'http://127.0.0.1/development-fixtures',
} as const;

export const demoSeedArtifactSessionId = '00000000-0000-4000-8000-000000000102';

export const demoSeedLifecycleSessions = {
  legacyReady: {
    id: '00000000-0000-4000-8000-000000000401',
    participantId: '00000000-0000-4000-8000-000000000402',
    title: 'Fixture lifecycle - Ready (legacy null status)',
    cachedStatus: null,
  },
  explicitReady: {
    id: '00000000-0000-4000-8000-000000000405',
    participantId: '00000000-0000-4000-8000-000000000406',
    title: 'Fixture lifecycle - Ready (explicit status)',
    cachedStatus: 'ready',
  },
  active: {
    id: '00000000-0000-4000-8000-000000000403',
    participantId: '00000000-0000-4000-8000-000000000404',
    title: 'Fixture lifecycle - Active control',
    cachedStatus: 'active',
    taskId: 'demo-seed-task-lifecycle-active',
  },
} as const;

export function isDemoSeedPreservedStatusSession(sessionId: string): boolean {
  return sessionId === demoSeedLifecycleSessions.legacyReady.id;
}
