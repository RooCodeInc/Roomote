import { describe, expect, it } from 'vitest';

import type { TaskArtifact } from '@/types';

import type { AcpToolResultUiMessage } from '../types';
import {
  extractVisualProofUploadFromToolMessage,
  resolveVisualProofDisplayMedia,
} from '../visual-proof-tool-result';

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

describe('extractVisualProofUploadFromToolMessage', () => {
  it('extracts a successful visual-proof manage_artifacts upload', () => {
    const msg = buildResultMessage({
      output: JSON.stringify({
        success: true,
        artifactId: 'art-1',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/view',
        rawUrl: 'https://example.com/raw',
      }),
    });

    expect(extractVisualProofUploadFromToolMessage(msg)).toEqual({
      artifactId: 'art-1',
      artifactType: 'visual-proof',
      viewUrl: 'https://example.com/view',
      rawUrl: 'https://example.com/raw',
    });
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

    expect(extractVisualProofUploadFromToolMessage(msg)).toBeNull();
  });

  it('rejects failed or in-progress tool results', () => {
    expect(
      extractVisualProofUploadFromToolMessage(
        buildResultMessage({
          status: 'failed',
          output: JSON.stringify({
            success: true,
            artifactId: 'art-1',
            artifactType: 'visual-proof',
            viewUrl: 'https://example.com/view',
          }),
        }),
      ),
    ).toBeNull();

    expect(
      extractVisualProofUploadFromToolMessage(
        buildResultMessage({
          status: 'in_progress',
          output: JSON.stringify({
            success: true,
            artifactId: 'art-1',
            artifactType: 'visual-proof',
            viewUrl: 'https://example.com/view',
          }),
        }),
      ),
    ).toBeNull();
  });

  it('falls back to message text when output is empty', () => {
    const msg = buildResultMessage({
      output: '',
      text: JSON.stringify({
        success: true,
        artifactId: 'art-2',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/view-2',
      }),
    });

    expect(extractVisualProofUploadFromToolMessage(msg)).toEqual({
      artifactId: 'art-2',
      artifactType: 'visual-proof',
      viewUrl: 'https://example.com/view-2',
    });
  });
});

describe('resolveVisualProofDisplayMedia', () => {
  it('prefers a session thumbnail over payload rawUrl', () => {
    const media = resolveVisualProofDisplayMedia(
      {
        artifactId: 'art-1',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/view',
        rawUrl: 'https://example.com/raw-stale',
      },
      [imageArtifact],
    );

    expect(media).toEqual({
      kind: 'image',
      src: '/api/artifacts/art-1/raw?sig=fresh&ts=1',
      viewUrl: 'https://example.com/view',
      artifactId: 'art-1',
      path: 'tmp/proof.png',
      version: 2,
    });
  });

  it('falls back to payload rawUrl before session artifacts exist', () => {
    const media = resolveVisualProofDisplayMedia(
      {
        artifactId: 'art-1',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/view',
        rawUrl: 'https://example.com/raw',
      },
      [],
    );

    expect(media).toEqual({
      kind: 'image',
      src: 'https://example.com/raw',
      viewUrl: 'https://example.com/view',
      artifactId: 'art-1',
    });
  });

  it('returns a link card when no image URL is available', () => {
    const media = resolveVisualProofDisplayMedia(
      {
        artifactId: 'art-1',
        artifactType: 'visual-proof',
        viewUrl: 'https://example.com/view',
      },
      [],
    );

    expect(media).toEqual({
      kind: 'link',
      viewUrl: 'https://example.com/view',
      artifactId: 'art-1',
    });
  });
});
