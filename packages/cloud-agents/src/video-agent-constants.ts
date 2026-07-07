export const VIDEO_AGENT_MAX_VIDEO_SIZE_BYTES = 20 * 1024 * 1024;

export const VIDEO_AGENT_SUPPORTED_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/mpeg',
] as const;

const VIDEO_AGENT_SUPPORTED_MIME_TYPE_SET = new Set<string>(
  VIDEO_AGENT_SUPPORTED_MIME_TYPES,
);

export function isVideoAgentSupportedMimeType(mimeType: string): boolean {
  return VIDEO_AGENT_SUPPORTED_MIME_TYPE_SET.has(mimeType);
}
