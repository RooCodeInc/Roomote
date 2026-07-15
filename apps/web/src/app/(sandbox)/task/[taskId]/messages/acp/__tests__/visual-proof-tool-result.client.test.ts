import { describe, expect, it } from 'vitest';

import type { TaskArtifact } from '@/types';

import type { AcpToolResultUiMessage } from '../types';
import { resolveVisualProofMediaForToolMessage } from '../visual-proof-tool-result';

function buildResultMessage(
  overrides?: Partial<AcpToolResultUiMessage['data']> & {
    text?: string;
    partial?: boolean;
  },
): AcpToolResultUiMessage {
  const { text, partial, ...data } = overrides ?? {};

  return {
    id: 'tool-result-1',
    ts: 1,
    role: 'tool',
    partial: partial ?? false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    text: text ?? '',
    data: {
      toolCallId: 'call-1',
      kind: 'mcp',
      title: 'manage_artifacts',
      status: 'completed',
      isExecute: false,
      isMcp: true,
      mcpServerName: 'roomote',
      mcpToolName: 'manage_artifacts',
      serverName: 'roomote',
      toolName: 'manage_artifacts',
      command: null,
      exitCode: null,
      output: '',
      ...data,
    },
  };
}

function buildSubagentResultMessage(
  overrides?: Partial<AcpToolResultUiMessage['data']> & {
    text?: string;
    partial?: boolean;
  },
): AcpToolResultUiMessage {
  const { text, partial, ...data } = overrides ?? {};

  return {
    id: 'tool-result-2',
    ts: 2,
    role: 'tool',
    partial: partial ?? false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_result',
    kind: 'tool_result',
    text: text ?? '',
    data: {
      toolCallId: 'call-2',
      kind: 'subagent',
      title: 'Capture app screenshot',
      status: 'completed',
      isExecute: false,
      isMcp: false,
      mcpServerName: null,
      mcpToolName: null,
      command: 'Take a screenshot of the app',
      exitCode: null,
      output: '',
      agentType: 'proof-runner',
      isSubagentSpawn: true,
      ...data,
    },
  };
}

const imageArtifact: TaskArtifact = {
  id: 'art-1',
  path: 'tmp/proof.png',
  version: 2,
  artifactType: 'visual-proof',
  contentType: 'image/png',
  size: 1234,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  thumbnailUrl: '/api/artifacts/art-1/raw?sig=fresh&ts=1',
};

describe('resolveVisualProofMediaForToolMessage (manage_artifacts result)', () => {
  it('extracts a successful visual-proof upload and prefers the session thumbnail', () => {
    const msg = buildResultMessage({
      output: JSON.stringify({
        success: true,
        artifactId: 'art-1',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/view',
        rawUrl: 'https://example.com/raw-stale',
      }),
    });

    expect(resolveVisualProofMediaForToolMessage(msg, [imageArtifact])).toEqual(
      [
        {
          kind: 'image',
          src: '/api/artifacts/art-1/raw?sig=fresh&ts=1',
          viewUrl: 'https://example.com/view',
          artifactId: 'art-1',
          path: 'tmp/proof.png',
          version: 2,
        },
      ],
    );
  });

  it('falls back to payload rawUrl before session artifacts exist', () => {
    const msg = buildResultMessage({
      output: JSON.stringify({
        success: true,
        artifactId: 'art-1',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/task/t1/artifacts/tmp/proof.png?v=4',
        rawUrl: 'https://example.com/raw',
      }),
    });

    expect(resolveVisualProofMediaForToolMessage(msg, [])).toEqual([
      {
        kind: 'image',
        src: 'https://example.com/raw',
        viewUrl: 'https://example.com/task/t1/artifacts/tmp/proof.png?v=4',
        artifactId: 'art-1',
        path: 'tmp/proof.png',
        version: 4,
      },
    ]);
  });

  it('rejects non-visual-proof uploads', () => {
    const msg = buildResultMessage({
      output: JSON.stringify({
        success: true,
        artifactId: 'art-1',
        artifactType: 'general',
        viewUrl: 'https://example.com/view',
        rawUrl: 'https://example.com/raw',
      }),
    });

    expect(resolveVisualProofMediaForToolMessage(msg, [imageArtifact])).toEqual(
      [],
    );
  });

  it('rejects failed or in-progress tool results', () => {
    for (const status of ['failed', 'in_progress'] as const) {
      const msg = buildResultMessage({
        status,
        output: JSON.stringify({
          success: true,
          artifactId: 'art-1',
          artifactType: 'visual-proof',
          viewUrl: 'https://example.com/view',
        }),
      });

      expect(
        resolveVisualProofMediaForToolMessage(msg, [imageArtifact]),
      ).toEqual([]);
    }
  });

  it('falls back to message text when output is empty', () => {
    const msg = buildResultMessage({
      output: '',
      text: JSON.stringify({
        success: true,
        artifactId: 'art-1',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/view-2',
      }),
    });

    expect(resolveVisualProofMediaForToolMessage(msg, [imageArtifact])).toEqual(
      [
        {
          kind: 'image',
          src: '/api/artifacts/art-1/raw?sig=fresh&ts=1',
          viewUrl: 'https://example.com/view-2',
          artifactId: 'art-1',
          path: 'tmp/proof.png',
          version: 2,
        },
      ],
    );
  });

  it('returns a link card when no image URL is available', () => {
    const msg = buildResultMessage({
      output: JSON.stringify({
        success: true,
        artifactId: 'art-1',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/task/t1/artifacts/tmp/proof.mp4?v=1',
      }),
    });

    expect(resolveVisualProofMediaForToolMessage(msg, [])).toEqual([
      {
        kind: 'link',
        viewUrl: 'https://example.com/task/t1/artifacts/tmp/proof.mp4?v=1',
        artifactId: 'art-1',
        path: 'tmp/proof.mp4',
        version: 1,
      },
    ]);
  });
});

describe('resolveVisualProofMediaForToolMessage (subagent result)', () => {
  const subagentOutput = [
    '<task id="ses-1" state="completed">',
    '<task_result>',
    'Summary: Captured and uploaded one cropped PNG.',
    'Screenshots:',
    '- `proof.png`',
    '  - viewUrl: https://example.com/task/t1/artifacts/tmp/proof.png?v=2',
    '  - rawUrl: https://example.com/api/artifacts/art-1/raw?sig=stale&ts=1',
    '</task_result>',
    '</task>',
  ].join('\n');

  it('resolves inline media from viewUrls in the subagent result text', () => {
    const msg = buildSubagentResultMessage({ output: subagentOutput });

    expect(resolveVisualProofMediaForToolMessage(msg, [imageArtifact])).toEqual(
      [
        {
          kind: 'image',
          src: '/api/artifacts/art-1/raw?sig=fresh&ts=1',
          viewUrl: 'https://example.com/task/t1/artifacts/tmp/proof.png?v=2',
          artifactId: 'art-1',
          path: 'tmp/proof.png',
          version: 2,
        },
      ],
    );
  });

  it('resolves multiple screenshots and dedupes repeated links', () => {
    const secondArtifact: TaskArtifact = {
      ...imageArtifact,
      id: 'art-2',
      path: 'tmp/other.png',
      version: 1,
      thumbnailUrl: '/api/artifacts/art-2/raw?sig=fresh&ts=1',
    };
    const msg = buildSubagentResultMessage({
      output: [
        'viewUrl: https://example.com/task/t1/artifacts/tmp/proof.png?v=2',
        'viewUrl: https://example.com/task/t1/artifacts/tmp/other.png?v=1',
        'again: https://example.com/task/t1/artifacts/tmp/proof.png?v=2',
      ].join('\n'),
    });

    const media = resolveVisualProofMediaForToolMessage(msg, [
      imageArtifact,
      secondArtifact,
    ]);

    expect(media.map((item) => item.artifactId)).toEqual(['art-1', 'art-2']);
  });

  it('matches the latest version when the viewUrl version is absent', () => {
    const olderVersion: TaskArtifact = {
      ...imageArtifact,
      id: 'art-old',
      version: 1,
      thumbnailUrl: '/api/artifacts/art-old/raw?sig=fresh&ts=1',
    };
    const msg = buildSubagentResultMessage({
      output: 'viewUrl: https://example.com/task/t1/artifacts/tmp/proof.png',
    });

    const media = resolveVisualProofMediaForToolMessage(msg, [
      olderVersion,
      imageArtifact,
    ]);

    expect(media.map((item) => item.artifactId)).toEqual(['art-1']);
  });

  it('renders video proofs through the session preview URL', () => {
    const videoArtifact: TaskArtifact = {
      id: 'art-video',
      path: 'tmp/proof.webm',
      version: 1,
      artifactType: 'visual-proof',
      contentType: 'video/webm',
      size: 4321,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      previewUrl: 'https://cdn.example.com/proof.webm',
    };
    const msg = buildSubagentResultMessage({
      output:
        'viewUrl: https://example.com/task/t1/artifacts/tmp/proof.webm?v=1',
    });

    expect(resolveVisualProofMediaForToolMessage(msg, [videoArtifact])).toEqual(
      [
        {
          kind: 'video',
          src: 'https://cdn.example.com/proof.webm',
          viewUrl: 'https://example.com/task/t1/artifacts/tmp/proof.webm?v=1',
          artifactId: 'art-video',
          path: 'tmp/proof.webm',
          version: 1,
        },
      ],
    );
  });

  it('ignores signed rawUrls and artifacts missing from the session', () => {
    const msg = buildSubagentResultMessage({
      output: [
        'rawUrl: https://example.com/api/artifacts/art-1/raw?sig=stale&ts=1',
        'viewUrl: https://example.com/task/t1/artifacts/tmp/missing.png?v=1',
      ].join('\n'),
    });

    expect(resolveVisualProofMediaForToolMessage(msg, [imageArtifact])).toEqual(
      [],
    );
  });

  it('ignores artifacts that are not visual proofs', () => {
    const generalArtifact: TaskArtifact = {
      ...imageArtifact,
      artifactType: 'general',
    };
    const msg = buildSubagentResultMessage({ output: subagentOutput });

    expect(
      resolveVisualProofMediaForToolMessage(msg, [generalArtifact]),
    ).toEqual([]);
  });

  it('ignores unfinished or failed subagent results', () => {
    expect(
      resolveVisualProofMediaForToolMessage(
        buildSubagentResultMessage({
          output: subagentOutput,
          status: 'in_progress',
        }),
        [imageArtifact],
      ),
    ).toEqual([]);

    expect(
      resolveVisualProofMediaForToolMessage(
        buildSubagentResultMessage({
          output: subagentOutput,
          status: 'failed',
        }),
        [imageArtifact],
      ),
    ).toEqual([]);

    expect(
      resolveVisualProofMediaForToolMessage(
        buildSubagentResultMessage({ output: subagentOutput, partial: true }),
        [imageArtifact],
      ),
    ).toEqual([]);
  });
});
