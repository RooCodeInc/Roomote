import {
  buildFastAgentTranscriptImageNotice,
  encodeFastAgentTranscriptImageId,
  parseFastAgentTranscriptImageId,
  selectBoundedFastAgentTranscriptImages,
  transcriptImagesFromRow,
} from '../fast-agent-transcript-images';

describe('Fast transcript images', () => {
  it('round-trips stable IDs without losing the original message event', () => {
    const id = encodeFastAgentTranscriptImageId('1712345678.123:user', 2);

    expect(parseFastAgentTranscriptImageId(id)).toEqual({
      eventId: '1712345678.123:user',
      imageIndex: 2,
    });
    expect(parseFastAgentTranscriptImageId('image:not base64:0')).toBeNull();
  });

  it('preserves message association and image order', () => {
    const images = transcriptImagesFromRow({
      eventId: '100.1:user',
      turnId: '100.1',
      ts: 100,
      turnSeq: 1,
      contentBlocks: [
        { type: 'text', text: 'Compare these dogs' },
        { type: 'image', mimeType: 'image/png', data: 'Zmlyc3Q=' },
        { type: 'image', mimeType: 'image/jpeg', data: 'c2Vjb25k' },
      ],
    });

    expect(
      images.map(({ id, messageText, file }) => ({ id, messageText, file })),
    ).toEqual([
      {
        id: encodeFastAgentTranscriptImageId('100.1:user', 1),
        messageText: 'Compare these dogs',
        file: { mime: 'image/png', url: 'data:image/png;base64,Zmlyc3Q=' },
      },
      {
        id: encodeFastAgentTranscriptImageId('100.1:user', 2),
        messageText: 'Compare these dogs',
        file: {
          mime: 'image/jpeg',
          url: 'data:image/jpeg;base64,c2Vjb25k',
        },
      },
    ]);
  });

  it('builds a text-only helper notice grouped by original message', () => {
    const rows = [
      {
        eventId: '100.1:user',
        turnId: '100.1',
        ts: 100,
        turnSeq: 1,
        contentBlocks: [
          { type: 'text' as const, text: 'First dog' },
          {
            type: 'image' as const,
            mimeType: 'image/png',
            data: 'Zmlyc3Q=',
          },
        ],
      },
      {
        eventId: '100.2:user',
        turnId: '100.2',
        ts: 200,
        turnSeq: 2,
        contentBlocks: [
          { type: 'text' as const, text: 'Second dog' },
          {
            type: 'image' as const,
            mimeType: 'image/jpeg',
            data: 'c2Vjb25k',
          },
        ],
      },
    ];
    const { images } = selectBoundedFastAgentTranscriptImages(
      [...rows].reverse(),
    );

    const notice = buildFastAgentTranscriptImageNotice(images, 'helper');

    expect(notice).toContain('message 100.1 ("First dog")');
    expect(notice).toContain(encodeFastAgentTranscriptImageId('100.1:user', 1));
    expect(notice).toContain('message 100.2 ("Second dog")');
    expect(notice).toContain(encodeFastAgentTranscriptImageId('100.2:user', 1));
    expect(notice).toContain('explicit IDs');
    expect(notice).not.toContain('Zmlyc3Q=');
  });
});
