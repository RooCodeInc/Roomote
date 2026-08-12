'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  preparePromptAttachments,
  ROOMOTE_FILE_ATTACHMENT_ACCEPT,
} from '@/lib/prompt-attachments';

import { useUser } from '@/hooks/useUser';
import { useVoiceDictation } from '@/hooks/useVoiceDictation';
import { useTRPC, useTRPCClient } from '@/trpc/client';

import {
  type PromptInputMessage,
  PromptInput as PromptInputRoot,
  PromptInputActionAddAttachments,
  PromptInputActionAddCommand,
  PromptInputActionAddContext,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
  VoiceDictationButton,
} from '@/components/ai-elements';
import { BasicTooltip, Loader2 } from '@/components/system';

import {
  useSandboxClient,
  useSandboxConnected,
  useSandboxConnectionStatus,
  useSandboxCurrentUserInfo,
  useSandboxQueuedMessages,
  useSandboxReadOnly,
  useSandboxTaskPhase,
} from '../hooks/SandboxProvider';
import type { TaskRunDetail } from '@/lib/server/task-runs';
import { TaskToolsButton } from '../sidebar-actions/TaskToolsButton';
import { shouldShowTaskToolsActions } from '../sidebar-actions/utils';
import { useOptionalPendingUserInputRequestState } from '../PendingUserInputRequestPanel';
import { isSteerablePhase } from '../steerable-phase';
import { shouldSteerQueuedMessageOnEnter } from './enter-steer-utils';
import { useOptimisticPromptSubmission } from './useOptimisticPromptSubmission';

import { AttachmentsDisplay } from './AttachmentsDisplay';
import { ContextUsage } from './ContextUsage';
import { SubmitWithAttachments } from './SubmitWithAttachments';
import { TaskStatus } from './TaskStatus';

const DRAFT_SAVE_DEBOUNCE_MS = 1_000;
const KEEPALIVE_TOUCH_THROTTLE_MS = 10_000;
const SANDBOX_CANCEL_TIMEOUT_MS = 10_000;

export interface PromptInputHandle {
  focus: () => void;
  insertFile: (path: string, insertPosition?: number | null) => void;
  insertCommand: (name: string, insertPosition?: number | null) => void;
}

interface PromptInputProps {
  initialPrompt?: string;
  onFileSearchOpen: (insertPosition?: number) => void;
  onCommandSearchOpen: (insertPosition?: number) => void;
  scrollToBottom?: () => void;
  taskRun?: TaskRunDetail | null;
  showTaskStatus?: boolean;
  showContextIndicator?: boolean;
  showTaskToolsMenu?: boolean;
  showInputMenu?: boolean;
  placeholder?: string;
  hasTransportError?: boolean;
}

export const PromptInput = forwardRef<PromptInputHandle, PromptInputProps>(
  function PromptInput(
    {
      initialPrompt = '',
      onFileSearchOpen,
      onCommandSearchOpen,
      scrollToBottom,
      taskRun,
      showTaskStatus = true,
      showContextIndicator = true,
      showTaskToolsMenu = true,
      showInputMenu = true,
      placeholder: placeholderProp,
      hasTransportError = false,
    },
    ref,
  ) {
    const trpc = useTRPC();
    const trpcClient = useTRPCClient();
    const client = useSandboxClient();
    const {
      rollbackOptimisticPromptSubmission,
      startOptimisticPromptSubmission,
    } = useOptimisticPromptSubmission();
    const connected = useSandboxConnected();
    const { connectionError } = useSandboxConnectionStatus();
    const taskPhase = useSandboxTaskPhase();
    const queuedMessages = useSandboxQueuedMessages();
    const readOnly = useSandboxReadOnly();
    const currentUserInfo = useSandboxCurrentUserInfo();
    const { user } = useUser();
    const pendingUserInputState = useOptionalPendingUserInputRequestState();
    const [prompt, setPrompt] = useState(initialPrompt);
    const [sending, setSending] = useState(false);
    const cancellingRef = useRef(false);
    const steeringQueuedMessageRef = useRef(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const runId = taskRun?.id;
    const taskId = taskRun?.taskId;

    const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const latestPromptRef = useRef(initialPrompt);
    const lastSavedPromptRef = useRef(initialPrompt);
    const lastKeepaliveTouchRef = useRef(0);
    const activeRunIdRef = useRef(runId);

    const { mutate: saveDraft } = useMutation(
      trpc.sandboxSession.saveDraftPrompt.mutationOptions({
        onSuccess: (_data, variables) => {
          if (variables.runId !== activeRunIdRef.current) {
            return;
          }

          lastSavedPromptRef.current = variables.draftPrompt;
        },
      }),
    );

    const isTaskRunning = taskPhase === 'running';
    const canSteerQueuedMessages =
      isSteerablePhase(taskPhase) &&
      (taskPhase !== 'waiting_for_prompt' || connected);
    const userImageUrl =
      currentUserInfo?.userImageUrl ?? user?.resource.imageUrl ?? undefined;
    const steerableQueuedMessages = queuedMessages.filter(
      (queuedMessage) => queuedMessage.optimistic !== true,
    );

    const focusTextarea = useCallback((selectionStart?: number) => {
      const textarea = textareaRef.current;

      if (!textarea) {
        return;
      }

      textarea.focus();

      if (typeof selectionStart === 'number') {
        textarea.setSelectionRange(selectionStart, selectionStart);
      }
    }, []);

    const touchKeepalive = useCallback(
      (force = false) => {
        const now = Date.now();

        if (
          !force &&
          now - lastKeepaliveTouchRef.current < KEEPALIVE_TOUCH_THROTTLE_MS
        ) {
          return;
        }

        client?.commands.touchKeepalive.mutate().catch(() => {});
        lastKeepaliveTouchRef.current = now;
      },
      [client],
    );

    const persistDraft = useCallback(
      (
        text: string,
        options?: {
          runIdOverride?: number;
          force?: boolean;
        },
      ) => {
        const targetRunId = options?.runIdOverride ?? runId;

        if (!targetRunId) {
          return;
        }

        if (!options?.force && text === lastSavedPromptRef.current) {
          return;
        }

        saveDraft({ runId: targetRunId, draftPrompt: text });
      },
      [runId, saveDraft],
    );

    const flushDraft = useCallback(
      (options?: { runIdOverride?: number; force?: boolean }) => {
        if (draftSaveTimerRef.current) {
          clearTimeout(draftSaveTimerRef.current);
          draftSaveTimerRef.current = null;
        }

        const latestPrompt = latestPromptRef.current;

        if (!options?.force && latestPrompt === lastSavedPromptRef.current) {
          return;
        }

        persistDraft(latestPrompt, options);
      },
      [persistDraft],
    );

    const scheduleDraftSave = useCallback(
      (text: string) => {
        if (draftSaveTimerRef.current) {
          clearTimeout(draftSaveTimerRef.current);
        }

        draftSaveTimerRef.current = setTimeout(() => {
          draftSaveTimerRef.current = null;
          persistDraft(text);
        }, DRAFT_SAVE_DEBOUNCE_MS);
      },
      [persistDraft],
    );

    const applyPromptChange = useCallback(
      (nextPrompt: string) => {
        latestPromptRef.current = nextPrompt;
        setPrompt(nextPrompt);
        touchKeepalive();
        scheduleDraftSave(nextPrompt);
      },
      [scheduleDraftSave, touchKeepalive],
    );

    const handlePromptChange = useCallback(
      (value: string) => {
        applyPromptChange(value);
      },
      [applyPromptChange],
    );

    const handleMessageSent = useCallback(() => {
      if (runId) {
        latestPromptRef.current = '';
        setPrompt('');
        flushDraft({ force: true });
      }
    }, [runId, flushDraft]);

    const updatePrompt = useCallback(
      (
        updater: (prev: string) => { nextPrompt: string; cursorTarget: number },
      ) => {
        const { nextPrompt, cursorTarget } = updater(latestPromptRef.current);
        applyPromptChange(nextPrompt);

        requestAnimationFrame(() => {
          focusTextarea(cursorTarget);
        });
      },
      [applyPromptChange, focusTextarea],
    );

    const insertFile = useCallback(
      (path: string, insertPosition?: number | null) => {
        const insertion = `/${path} `;

        updatePrompt((prev) => {
          if (
            typeof insertPosition === 'number' &&
            insertPosition <= prev.length
          ) {
            return {
              nextPrompt:
                prev.slice(0, insertPosition) +
                insertion +
                prev.slice(insertPosition),
              cursorTarget: insertPosition + insertion.length,
            };
          }

          const prefix = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
          const nextPrompt = `${prev}${prefix}@${insertion}`;

          return {
            nextPrompt,
            cursorTarget: nextPrompt.length,
          };
        });
      },
      [updatePrompt],
    );

    const insertCommand = useCallback(
      (name: string, insertPosition?: number | null) => {
        const insertion = `${name} `;

        updatePrompt((prev) => {
          if (
            typeof insertPosition === 'number' &&
            insertPosition <= prev.length
          ) {
            const before = prev.slice(0, insertPosition - 1);
            const after = prev.slice(insertPosition);
            const nextPrompt = before + insertion + after;

            return {
              nextPrompt,
              cursorTarget: before.length + insertion.length,
            };
          }

          const prefix = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
          const nextPrompt = `${prev}${prefix}${insertion}`;

          return {
            nextPrompt,
            cursorTarget: nextPrompt.length,
          };
        });
      },
      [updatePrompt],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => focusTextarea(),
        insertFile,
        insertCommand,
      }),
      [focusTextarea, insertFile, insertCommand],
    );

    const cancelledByName = currentUserInfo?.userName ?? user?.name ?? null;

    const handleCancel = useCallback(async () => {
      if (cancellingRef.current) {
        return;
      }

      cancellingRef.current = true;

      try {
        if (client) {
          try {
            // A dead transport does not always reject quickly (it can hang
            // for minutes on an unresponsive upstream), so bound the live
            // cancellation before falling back to the web API.
            await Promise.race([
              client.commands.cancelTask.mutate({
                cancelledBy: {
                  ...(cancelledByName ? { name: cancelledByName } : {}),
                  source: 'web',
                },
              }),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error('sandbox cancelTask timed out')),
                  SANDBOX_CANCEL_TIMEOUT_MS,
                ),
              ),
            ]);
            return;
          } catch (error) {
            console.error('[sandbox] cancelTask error:', error);
          }
        }

        if (!taskId) {
          return;
        }

        const result = await trpcClient.taskRuns.cancel.mutate({
          taskId,
          runId,
        });

        if (!result.success) {
          throw new Error(result.error);
        }
      } catch (err) {
        console.error('[sandbox] cancelTask fallback error:', err);
      } finally {
        cancellingRef.current = false;
      }
    }, [client, cancelledByName, runId, taskId, trpcClient]);

    const handleSubmit = useCallback(
      async (message: PromptInputMessage) => {
        const text = message.text.trim();
        const hasAttachments = (message.files?.length ?? 0) > 0;
        const goalCommandMatch = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text);
        const goalObjective = goalCommandMatch
          ? (goalCommandMatch[1] ?? '').trim()
          : null;
        // Keyed off the live pending request rather than the task phase:
        // the phase can report running while the turn is still blocked on
        // the question, and a message here must answer it, not steer.
        const shouldAnswerPendingFreeText =
          Boolean(pendingUserInputState?.activeFreeTextRequest) &&
          !hasAttachments;

        if (
          (!text && !hasAttachments) ||
          !client ||
          !taskRun?.taskId ||
          sending
        ) {
          return;
        }

        if (
          !shouldAnswerPendingFreeText &&
          goalObjective !== null &&
          (!goalObjective || hasAttachments)
        ) {
          toast.error(
            hasAttachments
              ? 'Goal Mode does not support attachments.'
              : 'Describe the goal after /goal.',
          );
          return;
        }

        handlePromptChange('');
        setSending(true);
        scrollToBottom?.();

        let optimisticClientMessageId: string | null = null;
        let optimisticLocation: 'transcript' | 'queue' | null = null;

        try {
          if (shouldAnswerPendingFreeText) {
            const answered =
              await pendingUserInputState!.submitFreeTextResponse(text);

            if (answered) {
              handleMessageSent();
            }

            return;
          }

          const preparedPrompt = await preparePromptAttachments({
            text: goalObjective ?? text,
            attachments: message.files,
          });

          // Sends steer into an in-flight turn (native injection when the
          // harness supports it), so the prompt lands in the transcript
          // rather than sitting in the queue until the turn ends.
          optimisticLocation = 'transcript';
          const { clientMessageId } = startOptimisticPromptSubmission({
            taskId: taskRun.taskId,
            prompt: preparedPrompt.text,
            images: preparedPrompt.images,
            location: optimisticLocation,
          });
          optimisticClientMessageId = clientMessageId;

          if (goalObjective !== null) {
            const started = await trpcClient.taskRuns.startGoal.mutate({
              taskId: taskRun.taskId,
              goal: { objective: goalObjective },
              clientMessageId,
              userImageUrl,
            });

            if (!started.success) {
              throw new Error(started.error);
            }
          } else {
            await trpcClient.sandboxSession.sendPrompt.mutate({
              taskId: taskRun.taskId,
              prompt: preparedPrompt.text,
              images: preparedPrompt.images,
              source: 'web',
              clientMessageId,
              userImageUrl,
              autoSteerWhenQueued: true,
            });
          }

          if (goalObjective !== null) {
            toast.success('Goal Mode enabled');
          }

          handleMessageSent();
        } catch (err) {
          if (optimisticClientMessageId) {
            const failedClientMessageId = optimisticClientMessageId;

            if (optimisticLocation) {
              rollbackOptimisticPromptSubmission({
                taskId: taskRun.taskId,
                clientMessageId: failedClientMessageId,
                location: optimisticLocation,
              });
            }
          }
          console.error('[sandbox] sendPrompt error:', err);
          toast.error(
            err instanceof Error ? err.message : 'Failed to send message.',
          );
        } finally {
          setSending(false);
        }
      },
      [
        client,
        pendingUserInputState,
        sending,
        handlePromptChange,
        scrollToBottom,
        handleMessageSent,
        taskRun,
        trpcClient,
        rollbackOptimisticPromptSubmission,
        startOptimisticPromptSubmission,
        userImageUrl,
      ],
    );

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        const cursor = e.target.selectionStart;

        handlePromptChange(value);

        // Detect a newly typed "/" at the very start of the message.
        if (cursor === 1 && value[0] === '/') {
          onCommandSearchOpen(cursor);
        }
      },
      [handlePromptChange, onCommandSearchOpen],
    );

    const voiceDictation = useVoiceDictation({
      onTranscript: (text) => handlePromptChange(text),
      getPrefix: () => prompt,
      taskPhase: taskPhase ?? undefined,
      disabled: !connected || sending,
    });

    useEffect(() => {
      if (activeRunIdRef.current === runId) {
        return;
      }

      if (activeRunIdRef.current) {
        flushDraft({ runIdOverride: activeRunIdRef.current });
      }

      activeRunIdRef.current = runId;
      latestPromptRef.current = initialPrompt;
      lastSavedPromptRef.current = initialPrompt;
      lastKeepaliveTouchRef.current = 0;
      setPrompt(initialPrompt);

      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    }, [runId, flushDraft, initialPrompt]);

    useEffect(
      () => () => {
        flushDraft({ runIdOverride: activeRunIdRef.current });
      },
      [flushDraft],
    );

    useEffect(() => {
      function handleElementPicked(event: Event) {
        const text = (event as CustomEvent<{ text: string }>).detail.text;
        const currentPrompt = latestPromptRef.current;
        const separator = currentPrompt.trim() ? '\n\n' : '';
        applyPromptChange(currentPrompt + separator + text + '\n\n');

        requestAnimationFrame(() => {
          const textarea = textareaRef.current;

          if (!textarea) {
            return;
          }

          const length = textarea.value.length;
          focusTextarea(length);
        });
      }

      window.addEventListener('roomote-element-picked', handleElementPicked);

      return () =>
        window.removeEventListener(
          'roomote-element-picked',
          handleElementPicked,
        );
    }, [applyPromptChange, focusTextarea]);

    // Re-focus the textarea after a message is sent. We use an effect rather
    // than focusing in handleSubmit because the inner PromptInput component
    // calls form.reset() *after* handleSubmit's promise resolves, which would
    // steal focus away from a synchronous .focus() call.
    const wasSendingRef = useRef(false);
    useEffect(() => {
      if (wasSendingRef.current && !sending) {
        // Delay one frame so the inner form.reset() completes first.
        requestAnimationFrame(() => focusTextarea());
      }
      wasSendingRef.current = sending;
    }, [sending, focusTextarea]);

    // Auto-focus the textarea when recording stops so the user can immediately
    // press Enter / Cmd+Enter to send the dictated text.
    const wasRecordingRef = useRef(false);
    useEffect(() => {
      if (wasRecordingRef.current && !voiceDictation.isRecording) {
        focusTextarea();
      }
      wasRecordingRef.current = voiceDictation.isRecording;
    }, [voiceDictation.isRecording, focusTextarea]);

    const placeholder = placeholderProp ?? 'Message agent - / for commands';
    const showConnectingStatus =
      !connected && !connectionError && !hasTransportError;

    const handleTextareaKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        const submitButton = event.currentTarget.form?.querySelector(
          'button[type="submit"]',
        ) as HTMLButtonElement | null;
        const hasEnabledSubmitButton = Boolean(
          submitButton && !submitButton.disabled,
        );

        if (
          !shouldSteerQueuedMessageOnEnter({
            key: event.key,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            isComposing: event.nativeEvent.isComposing,
            prompt,
            hasEnabledSubmitButton,
            hasClient: Boolean(client),
            readOnly,
            canSteerQueuedMessages,
            queuedMessagesCount: steerableQueuedMessages.length,
            steeringInFlight: steeringQueuedMessageRef.current,
          })
        ) {
          return;
        }

        const oldestQueuedMessageId = steerableQueuedMessages[0]?.id;

        if (!oldestQueuedMessageId || !client) {
          return;
        }

        event.preventDefault();
        steeringQueuedMessageRef.current = true;

        void client.commands.steerQueuedMessage
          .mutate({ queuedMessageId: oldestQueuedMessageId })
          .catch((error) => {
            console.error(
              '[sandbox] steerQueuedMessage from prompt input error:',
              error,
            );
          })
          .finally(() => {
            steeringQueuedMessageRef.current = false;
          });
      },
      [
        canSteerQueuedMessages,
        client,
        prompt,
        readOnly,
        steerableQueuedMessages,
      ],
    );

    return (
      <div className="mx-auto w-full max-w-4xl">
        <PromptInputRoot
          onSubmit={handleSubmit}
          accept={ROOMOTE_FILE_ATTACHMENT_ACCEPT}
          multiple
        >
          <AttachmentsDisplay />
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              value={prompt}
              onChange={handleChange}
              onBlur={() => flushDraft()}
              onKeyDown={handleTextareaKeyDown}
              placeholder={placeholder}
              disabled={!connected || sending}
            />
          </PromptInputBody>
          <PromptInputFooter className="pt-0 pb-4 px-4">
            <PromptInputTools>
              {showInputMenu && (
                <PromptInputActionMenu>
                  <BasicTooltip content="Add to task">
                    <PromptInputActionMenuTrigger
                      aria-label="Add to task"
                      className="hover:bg-secondary"
                    />
                  </BasicTooltip>
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments />
                    <PromptInputActionAddContext
                      onSelect={() => onFileSearchOpen()}
                    />
                    <PromptInputActionAddCommand
                      onSelect={() => onCommandSearchOpen()}
                    />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
              )}
              {showTaskToolsMenu &&
                taskRun &&
                shouldShowTaskToolsActions(taskRun.payloadKind) && (
                  <TaskToolsButton taskRun={taskRun} />
                )}
            </PromptInputTools>
            <div className="flex items-center gap-2">
              {showConnectingStatus && (
                <div
                  role="status"
                  aria-live="polite"
                  className="text-muted-foreground flex items-center gap-1.5 text-xs"
                >
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  <span>Connecting...</span>
                </div>
              )}
              {showTaskStatus && !showConnectingStatus && (
                <TaskStatus taskRun={taskRun} />
              )}
              {showContextIndicator && (
                <div className="hidden debug:block">
                  <ContextUsage />
                </div>
              )}
              <VoiceDictationButton
                isRecording={voiceDictation.isRecording}
                isSupported={voiceDictation.isSupported}
                onClick={voiceDictation.toggle}
                disabled={!connected || sending}
              />
              <SubmitWithAttachments
                isTaskRunning={isTaskRunning}
                connected={connected}
                sending={sending}
                prompt={prompt}
                handleCancel={handleCancel}
              />
            </div>
          </PromptInputFooter>
        </PromptInputRoot>
      </div>
    );
  },
);
