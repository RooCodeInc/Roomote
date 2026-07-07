'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  AcpRequestUserInputAnswers,
  AcpRequestUserInputQuestion,
} from '@roomote/types';
import { toast } from 'sonner';

import { useTRPCClient } from '@/trpc/client';
import type { PendingTaskUserInputRequest } from './hooks';

import {
  useSandboxClient,
  useSandboxPendingUserInputRequests,
  useSandboxTaskPhase,
} from './hooks';
import {
  buildAnswersForRequest,
  OTHER_VALUE,
  ensureQuestionDraft,
  PendingUserInputRequestCard,
  type RequestDraft,
} from './PendingUserInputRequestCard';

type RequestDrafts = Record<string, RequestDraft>;

type PendingRequestEntry = {
  request: PendingTaskUserInputRequest;
  requestDraft?: RequestDraft;
  currentQuestionIndex: number;
  currentQuestion: AcpRequestUserInputQuestion | null;
  isSubmitting: boolean;
};

type PendingUserInputRequestStateValue = {
  optionRequestEntries: PendingRequestEntry[];
  activeFreeTextRequest: PendingRequestEntry | null;
  shouldHidePromptInput: boolean;
  isConnected: boolean;
  activateOther: (
    request: PendingTaskUserInputRequest,
    question: AcpRequestUserInputQuestion,
  ) => void;
  changeOtherText: (
    request: PendingTaskUserInputRequest,
    question: AcpRequestUserInputQuestion,
    value: string,
  ) => void;
  submitOther: (
    request: PendingTaskUserInputRequest,
    question: AcpRequestUserInputQuestion,
  ) => void;
  selectOption: (
    request: PendingTaskUserInputRequest,
    question: AcpRequestUserInputQuestion,
    value: string,
  ) => void;
  goBack: (requestId: string) => void;
  dismiss: (request: PendingTaskUserInputRequest) => void;
  submitFreeTextResponse: (text: string) => Promise<boolean>;
};

const PendingUserInputRequestStateContext =
  createContext<PendingUserInputRequestStateValue | null>(null);

export function usePendingUserInputRequestState() {
  const context = useContext(PendingUserInputRequestStateContext);

  if (!context) {
    throw new Error(
      'usePendingUserInputRequestState must be used within PendingUserInputRequestStateProvider',
    );
  }

  return context;
}

export function useOptionalPendingUserInputRequestState() {
  return useContext(PendingUserInputRequestStateContext);
}

export function PendingUserInputRequestStateProvider({
  taskId,
  children,
}: {
  taskId: string;
  children: ReactNode;
}) {
  const client = useSandboxClient();
  const trpcClient = useTRPCClient();
  const taskPhase = useSandboxTaskPhase();
  const requests = useSandboxPendingUserInputRequests();

  const [drafts, setDrafts] = useState<RequestDrafts>({});
  const [submittingRequestIds, setSubmittingRequestIds] = useState<
    Record<string, boolean>
  >({});
  const [currentQuestionIndexes, setCurrentQuestionIndexes] = useState<
    Record<string, number>
  >({});
  const [resolvedRequestIds, setResolvedRequestIds] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    setDrafts((currentDrafts) =>
      Object.fromEntries(
        requests.map((request) => [
          request.requestId,
          Object.fromEntries(
            request.questions.map((question) => [
              question.id,
              ensureQuestionDraft(currentDrafts[request.requestId], question),
            ]),
          ),
        ]),
      ),
    );

    setSubmittingRequestIds((currentState) =>
      Object.fromEntries(
        Object.entries(currentState).filter(([requestId]) =>
          requests.some((request) => request.requestId === requestId),
        ),
      ),
    );

    setCurrentQuestionIndexes((currentState) =>
      Object.fromEntries(
        requests.map((request) => [
          request.requestId,
          Math.min(
            currentState[request.requestId] ?? 0,
            Math.max(request.questions.length - 1, 0),
          ),
        ]),
      ),
    );

    setResolvedRequestIds((currentState) =>
      Object.fromEntries(
        Object.entries(currentState).filter(([requestId]) =>
          requests.some((request) => request.requestId === requestId),
        ),
      ),
    );
  }, [requests]);

  const visibleRequests = useMemo(
    () =>
      taskPhase === 'waiting_for_user_input'
        ? requests.filter(
            (request) => resolvedRequestIds[request.requestId] !== true,
          )
        : [],
    [requests, resolvedRequestIds, taskPhase],
  );

  const requestEntries = useMemo<PendingRequestEntry[]>(
    () =>
      visibleRequests.map((request) => {
        const currentQuestionIndex =
          currentQuestionIndexes[request.requestId] ?? 0;
        const currentQuestion = request.questions[currentQuestionIndex] ?? null;

        return {
          request,
          requestDraft: drafts[request.requestId],
          currentQuestionIndex,
          currentQuestion,
          isSubmitting: submittingRequestIds[request.requestId] === true,
        };
      }),
    [currentQuestionIndexes, drafts, submittingRequestIds, visibleRequests],
  );

  const optionRequestEntries = useMemo(
    () =>
      requestEntries.filter(
        (entry) => (entry.currentQuestion?.options?.length ?? 0) > 0,
      ),
    [requestEntries],
  );

  const activeFreeTextRequest = useMemo(
    () =>
      requestEntries.find(
        (entry) =>
          entry.currentQuestion &&
          (entry.currentQuestion.options?.length ?? 0) === 0,
      ) ?? null,
    [requestEntries],
  );

  const shouldHidePromptInput =
    optionRequestEntries.length > 0 && activeFreeTextRequest === null;
  const isConnected = Boolean(client);

  const submitRequest = async (
    request: PendingTaskUserInputRequest,
    answers: AcpRequestUserInputAnswers,
  ) => {
    if (!client) {
      toast.error('Sandbox client is not connected');
      return;
    }

    setSubmittingRequestIds((currentState) => ({
      ...currentState,
      [request.requestId]: true,
    }));

    try {
      await trpcClient.sandboxSession.answerUserInputRequest.mutate({
        taskId,
        requestId: request.requestId,
        answers,
      });
      setResolvedRequestIds((currentState) => ({
        ...currentState,
        [request.requestId]: true,
      }));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to submit user input request',
      );
    } finally {
      setSubmittingRequestIds((currentState) => ({
        ...currentState,
        [request.requestId]: false,
      }));
    }
  };

  const advanceOrSubmitRequest = (
    request: PendingTaskUserInputRequest,
    nextDraft: RequestDraft,
    currentQuestionIndex: number,
  ) => {
    const isLastQuestion =
      currentQuestionIndex === request.questions.length - 1;

    if (!isLastQuestion) {
      setCurrentQuestionIndexes((currentState) => ({
        ...currentState,
        [request.requestId]: Math.min(
          (currentState[request.requestId] ?? 0) + 1,
          request.questions.length - 1,
        ),
      }));
      return;
    }

    void submitRequest(request, buildAnswersForRequest(request, nextDraft));
  };

  const activateOther = (
    request: PendingTaskUserInputRequest,
    question: AcpRequestUserInputQuestion,
  ) => {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [request.requestId]: {
        ...(currentDrafts[request.requestId] ?? {}),
        [question.id]: {
          ...ensureQuestionDraft(currentDrafts[request.requestId], question),
          selectedValue: OTHER_VALUE,
        },
      },
    }));
  };

  const changeOtherText = (
    request: PendingTaskUserInputRequest,
    question: AcpRequestUserInputQuestion,
    value: string,
  ) => {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [request.requestId]: {
        ...(currentDrafts[request.requestId] ?? {}),
        [question.id]: {
          ...ensureQuestionDraft(currentDrafts[request.requestId], question),
          selectedValue: OTHER_VALUE,
          otherText: value,
        },
      },
    }));
  };

  const submitOther = (
    request: PendingTaskUserInputRequest,
    question: AcpRequestUserInputQuestion,
  ) => {
    const entry = requestEntries.find(
      (candidate) => candidate.request.requestId === request.requestId,
    );

    if (!entry) {
      return;
    }

    const nextDraft = {
      ...(entry.requestDraft ?? {}),
      [question.id]: {
        ...ensureQuestionDraft(entry.requestDraft, question),
        selectedValue: OTHER_VALUE,
      },
    };

    if (nextDraft[question.id]?.otherText.trim().length === 0) {
      return;
    }

    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [request.requestId]: nextDraft,
    }));

    advanceOrSubmitRequest(request, nextDraft, entry.currentQuestionIndex);
  };

  const selectOption = (
    request: PendingTaskUserInputRequest,
    question: AcpRequestUserInputQuestion,
    value: string,
  ) => {
    const entry = requestEntries.find(
      (candidate) => candidate.request.requestId === request.requestId,
    );

    if (!entry) {
      return;
    }

    const nextDraft = {
      ...(entry.requestDraft ?? {}),
      [question.id]: {
        ...ensureQuestionDraft(entry.requestDraft, question),
        selectedValue: value,
      },
    };

    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [request.requestId]: nextDraft,
    }));

    advanceOrSubmitRequest(request, nextDraft, entry.currentQuestionIndex);
  };

  const goBack = (requestId: string) => {
    setCurrentQuestionIndexes((currentState) => ({
      ...currentState,
      [requestId]: Math.max((currentState[requestId] ?? 0) - 1, 0),
    }));
  };

  const dismiss = (request: PendingTaskUserInputRequest) => {
    void submitRequest(request, {});
  };

  const submitFreeTextResponse = async (text: string) => {
    const entry = activeFreeTextRequest;
    const question = entry?.currentQuestion;

    if (!entry || !question) {
      return false;
    }

    const trimmedText = text.trim();

    if (trimmedText.length === 0) {
      return false;
    }

    const nextDraft = {
      ...(entry.requestDraft ?? {}),
      [question.id]: {
        ...ensureQuestionDraft(entry.requestDraft, question),
        otherText: trimmedText,
      },
    };

    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [entry.request.requestId]: nextDraft,
    }));

    advanceOrSubmitRequest(
      entry.request,
      nextDraft,
      entry.currentQuestionIndex,
    );

    return true;
  };

  const value: PendingUserInputRequestStateValue = {
    optionRequestEntries,
    activeFreeTextRequest,
    shouldHidePromptInput,
    isConnected,
    activateOther,
    changeOtherText,
    submitOther,
    selectOption,
    goBack,
    dismiss,
    submitFreeTextResponse,
  };

  return (
    <PendingUserInputRequestStateContext.Provider value={value}>
      {children}
    </PendingUserInputRequestStateContext.Provider>
  );
}

export function PendingUserInputRequestPanel() {
  const {
    optionRequestEntries,
    isConnected,
    activateOther,
    changeOtherText,
    submitOther,
    selectOption,
    goBack,
    dismiss,
  } = usePendingUserInputRequestState();

  if (optionRequestEntries.length === 0) {
    return null;
  }

  return (
    <>
      {optionRequestEntries.map(
        ({ request, requestDraft, isSubmitting, currentQuestionIndex }) => (
          <PendingUserInputRequestCard
            key={request.requestId}
            request={request}
            requestDraft={requestDraft}
            isSubmitting={isSubmitting}
            currentQuestionIndex={currentQuestionIndex}
            isConnected={isConnected}
            onActivateOther={(question) => activateOther(request, question)}
            onOtherTextChange={(question, value) =>
              changeOtherText(request, question, value)
            }
            onSubmitOther={(question) => submitOther(request, question)}
            onSelectOption={(question, value) =>
              selectOption(request, question, value)
            }
            onBack={() => goBack(request.requestId)}
            onDismiss={() => dismiss(request)}
          />
        ),
      )}
    </>
  );
}
