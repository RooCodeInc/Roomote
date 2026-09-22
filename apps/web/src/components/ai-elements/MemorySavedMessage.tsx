import {
  ACP_ENVELOPE_EVENT_TYPES,
  MEMORY_SAVED_EVENT_TEXT,
  parseMemorySavedEventPayload,
} from '@roomote/types';

import { Brain } from '@/components/system';
import type { AcpUiMessage } from '@/app/(sandbox)/task/[taskId]/types';

export function MemorySavedMessage({ message }: { message: AcpUiMessage }) {
  if (message.updateType !== ACP_ENVELOPE_EVENT_TYPES.MemorySaved) {
    return null;
  }

  const payload = parseMemorySavedEventPayload(message.data);

  return (
    <details className="group my-2 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1 hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
        <Brain className="size-3.5" />
        <span>{MEMORY_SAVED_EVENT_TEXT}</span>
        {payload ? (
          <span className="text-muted-foreground/70">
            {payload.memories.length}
          </span>
        ) : null}
      </summary>
      {payload ? (
        <ul className="mt-1 space-y-1 border-l border-border pl-5 text-muted-foreground">
          {payload.memories.map((memory) => (
            <li key={memory} className="whitespace-pre-line">
              {memory}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
