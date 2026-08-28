import {
  architectureSnapshotSchema,
  parseArchitectureSnapshot,
  serializeArchitectureSnapshot,
  taskArtifactTypeSchema,
  uploadArtifactTypeSchema,
} from './task-artifacts';

const validSnapshot = {
  schemaVersion: 1 as const,
  title: 'Task artifact publication flow',
  mermaid: 'flowchart LR\n  Agent --> API --> Store',
  sources: [
    {
      repository: 'RooCodeInc/Roomote',
      path: 'apps/api/src/handlers/artifacts/create.ts',
      lineStart: 71,
      lineEnd: 104,
      description: 'Validates and creates the artifact record.',
    },
  ],
};

describe('architectureSnapshotSchema', () => {
  it('serializes and parses the versioned contract', () => {
    const serialized = serializeArchitectureSnapshot(validSnapshot);
    const parsed = parseArchitectureSnapshot(serialized);

    expect(serialized.endsWith('\n')).toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(validSnapshot);
  });

  it.each([
    '/etc/passwd',
    '../secrets.txt',
    'apps/web/../secrets.txt',
    'https://example.com/source.ts',
    'apps\\web\\source.ts',
  ])('rejects unsafe source path %s', (path) => {
    expect(
      architectureSnapshotSchema.safeParse({
        ...validSnapshot,
        sources: [{ ...validSnapshot.sources[0], path }],
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported versions and invalid line ranges', () => {
    expect(
      architectureSnapshotSchema.safeParse({
        ...validSnapshot,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      architectureSnapshotSchema.safeParse({
        ...validSnapshot,
        sources: [{ ...validSnapshot.sources[0], lineStart: 20, lineEnd: 10 }],
      }).success,
    ).toBe(false);
  });

  it('rejects malformed JSON', () => {
    expect(parseArchitectureSnapshot('{').success).toBe(false);
  });
});

describe('architecture-snapshot artifact type', () => {
  it('is accepted by task and generic upload validation', () => {
    expect(taskArtifactTypeSchema.parse('architecture-snapshot')).toBe(
      'architecture-snapshot',
    );
    expect(uploadArtifactTypeSchema.parse('architecture-snapshot')).toBe(
      'architecture-snapshot',
    );
  });
});
