import assert from 'node:assert/strict';

import {
  demoSeedArtifactSessionId,
  getSessionArtifactByPath,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import { createSessionArtifact } from '@roomote/sdk/server';

const artifacts = [
  {
    path: 'fixtures/launch-readiness.csv',
    contentType: 'text/csv',
    content: [
      'area,owner,status',
      'Authentication,Platform,Ready',
      'Billing,Commerce,Ready',
      'Rollback,Infrastructure,Needs review',
    ].join('\n'),
  },
  {
    path: 'fixtures/mobile-checks.tsv',
    contentType: 'text/tab-separated-values',
    content: [
      'journey\tviewport\tresult',
      'Session transcript\t390x844\tPass',
      'Artifact gallery\t390x844\tPass',
      'Ready filter\t1440x1000\tPass',
    ].join('\n'),
  },
] as const;

assert.equal(
  Env.APP_ENV,
  'development',
  'Refusing to seed demo artifacts outside development.',
);

for (const artifact of artifacts) {
  const existing = await getSessionArtifactByPath({
    sessionId: demoSeedArtifactSessionId,
    path: artifact.path,
  });
  if (existing) {
    console.log(`  exists  artifact ${artifact.path}`);
    continue;
  }

  await createSessionArtifact({
    sessionId: demoSeedArtifactSessionId,
    path: artifact.path,
    content: artifact.content,
    contentType: artifact.contentType,
    artifactType: 'general',
  });
  console.log(`  created artifact ${artifact.path}`);
}

process.exit(0);
