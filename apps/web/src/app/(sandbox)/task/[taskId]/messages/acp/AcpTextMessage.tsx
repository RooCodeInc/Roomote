import { useEffect, useState, type ComponentType } from 'react';
import Image from 'next/image';
import { toast } from 'sonner';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  getPrReviewNotificationAction,
  PR_REVIEW_ACTION_PROCESSING_LEASE_MS,
  type AcpRequestUserInputPayload,
  type PrReviewNotificationActionStatus,
  getProviderRetryNoticeFromMessageData,
  getTerminalProviderErrorFromMessageData,
  parseLinkedReviewResults,
  stripLlmCitationArtifacts,
} from '@roomote/types';

import { cn } from '@/lib/utils';
import { useTRPCClient } from '@/trpc/client';

import {
  BasicTooltip,
  Button,
  ChevronDownIcon,
  Loader2,
  MediaViewerDialog,
  MediaViewerImage,
} from '@/components/system';
import {
  type CollapsibleToggleRenderProps,
  Attachment,
  AttachmentPreview,
  Attachments,
  CollapsibleContent,
  Message,
  MessageActions,
  MessageContent,
  MessagePlainText,
  MessageCopyButton,
  MessageNewTaskButton,
  MessageResponse,
  MessageTimestamp,
} from '@/components/ai-elements';

import { getTaskToolByInvocation } from '../../task-tools';
import { useInternalTranscriptRowsVisible } from '../../useInternalTranscriptRowsVisible';
import { messageAnchorId } from '../message-anchor';
import type { AcpUiMessage } from './types';
import { ProviderRetryNoticeMessage } from './ProviderRetryNoticeMessage';
import { TerminalProviderErrorMessage } from './TerminalProviderErrorMessage';

const UserMessageToggle = ({
  isExpanded,
  toggle,
}: CollapsibleToggleRenderProps) => (
  <div className="flex justify-center relative top-1">
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'text-foreground',
        'transition-all relative',
        isExpanded ? 'hover:-top-0.5' : 'hover:top-0.5',
      )}
      onClick={toggle}
    >
      <ChevronDownIcon
        className={cn(
          'size-3.5 transition-transform hover:text-accent-foreground dark:hover:text-foreground',
          isExpanded && 'rotate-180',
        )}
      />
    </Button>
  </div>
);

const TaskToolChip = ({
  label,
  Icon,
}: {
  label: string;
  Icon: ComponentType<{ className?: string }>;
}) => (
  <div className="flex items-center gap-2 w-fit cursor-default -ml-1">
    <Icon className="size-4 text-muted-foreground shrink-0" />
    <span className="font-medium">{label}</span>
  </div>
);

function getImageMediaType(url: string): string {
  const dataUrlMatch = url.match(/^data:([^;]+);/i);
  return dataUrlMatch?.[1] ?? 'image/*';
}

interface AcpTextMessageProps {
  msg: AcpUiMessage;
}

function PrReviewNotificationActions({ msg }: { msg: AcpUiMessage }) {
  const action = getPrReviewNotificationAction(
    msg.data as Record<string, unknown>,
  );
  const trpcClient = useTRPCClient();
  const [status, setStatus] = useState<PrReviewNotificationActionStatus | null>(
    action?.status === 'processing' &&
      (action.processingStartedAt ?? 0) <=
        Date.now() - PR_REVIEW_ACTION_PROCESSING_LEASE_MS
      ? 'pending'
      : (action?.status ?? null),
  );
  const [submittingAction, setSubmittingAction] = useState<
    'resolve' | 'auto_resolve' | 'dismiss' | null
  >(null);

  useEffect(() => {
    if (action?.status !== 'processing' || !action.processingStartedAt) {
      return;
    }

    const remainingMs =
      action.processingStartedAt +
      PR_REVIEW_ACTION_PROCESSING_LEASE_MS -
      Date.now();

    if (remainingMs <= 0) {
      setStatus('pending');
      return;
    }

    const timeout = window.setTimeout(() => setStatus('pending'), remainingMs);
    return () => window.clearTimeout(timeout);
  }, [action?.processingStartedAt, action?.status]);

  if (!action || status === null) {
    return null;
  }

  const submit = async (
    selectedAction: 'resolve' | 'auto_resolve' | 'dismiss',
  ) => {
    setSubmittingAction(selectedAction);
    setStatus('processing');

    try {
      const result =
        await trpcClient.sandboxSession.handlePrReviewNotificationAction.mutate(
          {
            taskId: action.taskId,
            messageId: msg.id,
            action: selectedAction,
          },
        );
      setStatus(result.status as PrReviewNotificationActionStatus);

      if (
        selectedAction === 'auto_resolve' &&
        !result.currentFeedbackDispatched
      ) {
        toast.warning(
          'Future feedback will be resolved automatically, but this task could not resume for the current feedback.',
        );
      }
    } catch (error) {
      setStatus('pending');
      toast.error(
        error instanceof Error ? error.message : 'Failed to handle feedback.',
      );
    } finally {
      setSubmittingAction(null);
    }
  };

  if (status !== 'pending' && status !== 'processing') {
    const resolution = {
      resolved: 'Resolution requested.',
      auto_resolved:
        'Future feedback on this PR will be resolved automatically.',
      dismissed: 'Dismissed.',
    }[status];

    return (
      <p className="mt-3 text-sm text-muted-foreground" role="status">
        {resolution}
      </p>
    );
  }

  const isSubmitting = status === 'processing';

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2"
      data-testid="pr-review-notification-actions"
    >
      <Button
        size="sm"
        disabled={isSubmitting}
        onClick={() => void submit('resolve')}
      >
        {submittingAction === 'resolve' ? (
          <Loader2 className="animate-spin" />
        ) : null}
        Resolve these issues
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isSubmitting}
        onClick={() => void submit('auto_resolve')}
      >
        {submittingAction === 'auto_resolve' ? (
          <Loader2 className="animate-spin" />
        ) : null}
        Auto-resolve on this PR
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={isSubmitting}
        onClick={() => void submit('dismiss')}
      >
        {submittingAction === 'dismiss' ? (
          <Loader2 className="animate-spin" />
        ) : null}
        Dismiss
      </Button>
    </div>
  );
}

function getUserTooltipContent(msg: AcpUiMessage): string {
  const userName = msg.userName ?? 'User';

  return msg.userEmail ? `${userName} (${msg.userEmail})` : userName;
}

function formatLinkedReviewResultTitle(
  reviewKind: 'initial' | 'sync' | null,
  outcome: string | null,
  findingCount: number | null,
  approvalStatus: 'approved' | 'skipped' | null,
): string {
  const phaseLabel = reviewKind === 'sync' ? 'Re-review' : 'Initial review';

  switch (outcome) {
    case 'findings_remain':
      return `${phaseLabel} finished: ${
        findingCount === null
          ? 'actionable findings remain'
          : `${findingCount} actionable finding${findingCount === 1 ? '' : 's'} remain`
      }`;
    case 'clean':
      return `${phaseLabel} finished: no actionable issues remain`;
    case 'no_new_delta':
      return `${phaseLabel} finished: no new delta`;
    case 'approved':
      return `${phaseLabel} finished: approved`;
    case 'clean_approval_skipped':
      return `${phaseLabel} finished: clean; approval skipped`;
    default:
      if (approvalStatus === 'approved') {
        return `${phaseLabel} finished: approved`;
      }

      if (approvalStatus === 'skipped') {
        return `${phaseLabel} finished: clean; approval skipped`;
      }

      return `${phaseLabel} update`;
  }
}

interface RequestUserInputResponseDisplay {
  title: string | null;
  questionTexts: string[];
}

function getRequestUserInputResponseDisplay(
  msg: AcpUiMessage,
): RequestUserInputResponseDisplay {
  const data = msg.data as {
    resolution?: string | null;
    request?: AcpRequestUserInputPayload | null;
  };
  const questionTexts = (data.request?.questions ?? [])
    .map((question) => question.question.trim())
    .filter((text) => text.length > 0);

  return {
    title: data.resolution === 'cancelled' ? 'Cancelled requested input' : null,
    questionTexts,
  };
}

export function AcpTextMessage({ msg }: AcpTextMessageProps) {
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(
    null,
  );
  const showPersistentTimestamp = useInternalTranscriptRowsVisible();
  const isUser = msg.role === 'user';
  const baseContent = isUser
    ? (msg.text ?? '')
    : stripLlmCitationArtifacts(msg.text ?? '');
  const anchorId = messageAnchorId(msg.ts);
  const taskTool = isUser ? getTaskToolByInvocation(baseContent) : undefined;
  const linkedReviewResult = isUser
    ? parseLinkedReviewResults(baseContent)
    : null;
  const providerRetryNotice =
    !isUser && msg.kind === 'text'
      ? getProviderRetryNoticeFromMessageData(
          msg.data as Record<string, unknown>,
        )
      : null;
  const terminalProviderError =
    !isUser && msg.kind === 'text'
      ? getTerminalProviderErrorFromMessageData(
          msg.data as Record<string, unknown>,
        )
      : null;
  const requestUserInputResponse =
    isUser &&
    msg.updateType === ACP_ENVELOPE_EVENT_TYPES.RequestUserInputResponse
      ? getRequestUserInputResponseDisplay(msg)
      : null;
  const content = requestUserInputResponse
    ? [
        requestUserInputResponse.title,
        ...requestUserInputResponse.questionTexts,
        baseContent,
      ]
        .filter(
          (part): part is string => typeof part === 'string' && part.length > 0,
        )
        .join('\n\n')
    : baseContent;
  const shouldShowContentActions = isUser
    ? msg.partial !== true && !taskTool && !linkedReviewResult
    : msg.partial !== true &&
      msg.isTurnCompletion === true &&
      !providerRetryNotice &&
      !terminalProviderError;
  const messageContentClassName = cn(
    'min-w-0 flex-1',
    isUser ? 'pt-8' : 'py-0',
  );
  const userTooltipContent = getUserTooltipContent(msg);
  const selectedImageUrl =
    selectedImageIndex === null
      ? null
      : (msg.images?.[selectedImageIndex] ?? null);
  const selectedImageLabel =
    selectedImageIndex === null
      ? 'Conversation image attachment'
      : `Conversation image attachment ${selectedImageIndex + 1}`;

  if (!msg.partial && content === '' && !msg.images?.length) {
    return;
  }

  return (
    <Message from={isUser ? 'user' : 'assistant'}>
      <div
        className={cn('flex items-start gap-2', isUser && 'flex-row-reverse')}
      >
        {isUser && msg.userImageUrl ? (
          <BasicTooltip content={userTooltipContent}>
            <div className="shrink-0 pt-1 mt-8">
              <Image
                src={msg.userImageUrl}
                alt={msg.userName ?? 'User'}
                width={24}
                height={24}
                className="size-6 rounded-full"
              />
            </div>
          </BasicTooltip>
        ) : null}
        <MessageContent id={anchorId} className={messageContentClassName}>
          {msg.images?.length ? (
            <Attachments variant="grid">
              {msg.images.map((url, i) => (
                <button
                  key={`${msg.ts}-${i}`}
                  type="button"
                  className="rounded-lg bg-transparent p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => setSelectedImageIndex(i)}
                  aria-label={`Open conversation image attachment ${i + 1}`}
                >
                  <Attachment
                    data={{
                      id: `${msg.ts}-${i}`,
                      type: 'file',
                      url,
                      mediaType: getImageMediaType(url),
                    }}
                    className="cursor-zoom-in transition-opacity hover:opacity-90"
                  >
                    <AttachmentPreview />
                  </Attachment>
                </button>
              ))}
            </Attachments>
          ) : null}
          {taskTool ? (
            <TaskToolChip label={taskTool.label} Icon={taskTool.icon} />
          ) : linkedReviewResult ? (
            <div
              className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm"
              data-testid="linked-review-result"
            >
              <p
                className="font-medium"
                data-testid="linked-review-result-title"
              >
                {linkedReviewResult.title ??
                  formatLinkedReviewResultTitle(
                    linkedReviewResult.reviewKind,
                    linkedReviewResult.outcome,
                    linkedReviewResult.findingCount,
                    linkedReviewResult.approvalStatus,
                  )}
              </p>
              <p
                className="mt-1 text-muted-foreground whitespace-pre-wrap"
                data-testid="linked-review-result-summary"
              >
                {linkedReviewResult.summary}
              </p>
            </div>
          ) : providerRetryNotice ? (
            <ProviderRetryNoticeMessage
              data={msg.data as Record<string, unknown>}
              text={content}
            />
          ) : terminalProviderError ? (
            <TerminalProviderErrorMessage
              data={msg.data as Record<string, unknown>}
            />
          ) : isUser ? (
            <CollapsibleContent renderToggle={UserMessageToggle}>
              <MessagePlainText
                data-testid={
                  requestUserInputResponse
                    ? 'request-user-input-response'
                    : undefined
                }
              >
                {requestUserInputResponse ? (
                  <>
                    {requestUserInputResponse.title ? (
                      <span className="block text-xs font-medium text-muted-foreground">
                        {requestUserInputResponse.title}
                      </span>
                    ) : null}
                    {requestUserInputResponse.questionTexts.map(
                      (questionText, index) => (
                        <p
                          key={index}
                          className="mt-1 border-l-2 pl-2 text-muted-foreground"
                        >
                          {questionText}
                        </p>
                      ),
                    )}
                    <span className="mt-2 block">{baseContent}</span>
                  </>
                ) : (
                  baseContent
                )}
              </MessagePlainText>
            </CollapsibleContent>
          ) : (
            <MessageResponse>{content}</MessageResponse>
          )}
          {!isUser && msg.kind === 'text' ? (
            <PrReviewNotificationActions msg={msg} />
          ) : null}
        </MessageContent>
      </div>
      {showPersistentTimestamp && !msg.partial && (
        <MessageActions
          className={cn('md:opacity-100', isUser && 'justify-end')}
        >
          <MessageTimestamp
            ts={msg.ts}
            previousTs={msg.previousTs}
            anchorId={anchorId}
          />
        </MessageActions>
      )}
      {shouldShowContentActions && (
        <MessageActions>
          <MessageCopyButton content={content} />
          <MessageNewTaskButton content={content} />
          {!showPersistentTimestamp && (
            <MessageTimestamp
              ts={msg.ts}
              previousTs={msg.previousTs}
              anchorId={anchorId}
            />
          )}
        </MessageActions>
      )}

      <MediaViewerDialog
        open={selectedImageIndex !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setSelectedImageIndex(null);
          }
        }}
        title={selectedImageLabel}
      >
        <MediaViewerImage src={selectedImageUrl} alt={selectedImageLabel} />
      </MediaViewerDialog>
    </Message>
  );
}
