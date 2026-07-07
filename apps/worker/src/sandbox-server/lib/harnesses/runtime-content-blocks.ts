import type { TaskMessageContentBlock } from '@roomote/types';

export function createImageContentBlocks(
  images: string[] | undefined,
): TaskMessageContentBlock[] {
  return (images ?? []).map((image) => {
    if (image.startsWith('data:')) {
      const match = /^data:([^;]+);base64,(.+)$/u.exec(image);

      if (match?.[1] && match[2]) {
        return {
          type: 'image',
          mimeType: match[1],
          data: match[2],
        } satisfies TaskMessageContentBlock;
      }
    }

    return {
      type: 'resource_link',
      uri: image,
      name: image,
    } satisfies TaskMessageContentBlock;
  });
}
