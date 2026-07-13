import { deriveDaytonaWorkerSnapshotName } from './daytona';
import { deriveE2bWorkerTemplateRef } from './e2b';

describe('hosted worker artifact versioning', () => {
  it('includes the runtime schema in E2B template refs', () => {
    expect(deriveE2bWorkerTemplateRef('ghcr.io/roomote/worker:v1.2.3')).toBe(
      'roomote-worker:v1.2.3-r3',
    );
  });

  it('includes the runtime schema in Daytona snapshot names', () => {
    expect(
      deriveDaytonaWorkerSnapshotName('ghcr.io/roomote/worker:v1.2.3'),
    ).toBe('roomote-worker-v1.2.3-r3');
  });
});
