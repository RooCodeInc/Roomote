'use client';

interface PreviewClickLikeEvent {
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export function buildPreviewIframeUrl(
  previewUrl: string,
  cloudJobId: number,
): string {
  return `/api/auth/preview-iframe?${new URLSearchParams({
    preview_url: previewUrl,
    cloud_job_id: String(cloudJobId),
  }).toString()}`;
}

export function isModifiedClick(event: PreviewClickLikeEvent): boolean {
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  );
}
