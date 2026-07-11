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
  runId: number,
): string {
  return `/api/auth/preview-iframe?${new URLSearchParams({
    preview_url: previewUrl,
    task_run_id: String(runId),
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
