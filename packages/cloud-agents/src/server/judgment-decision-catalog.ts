import type { CodingModelRoutingRule, TaskModelOption } from '@roomote/types';

import {
  CRITERIA_MET_QUESTION,
  DUPLICATE_QUESTION,
} from './channel-launch-gate';
import {
  buildRequestedModelQuestion,
  buildRoutingRuleQuestion,
  describeDefaultModel,
  WANTS_NON_DEFAULT_MODEL_QUESTION,
} from './fast-agent/fast-agent-launch-model';
import { MEMORY_GATE_QUESTIONS } from './fast-agent/fast-agent-post-turn-memory';
import {
  TASK_COMMUNICATION_QUESTIONS,
  type TaskCommunicationTriageState,
} from './fast-agent/fast-agent-task-communication-triage';
import { INTEGRATION_TOOL_AUTO_QUESTIONS } from './integration-tool-auto-evaluation';
import {
  AGENTMAIL_AUTO_REPLY_QUESTION,
  CUSTOM_AUTOMATION_LAUNCH_CRITERIA_QUESTION,
  REPLY_ADDRESSEE_QUESTION,
  SESSION_STATUS_JUDGMENT_QUESTIONS,
} from './judgment-questions';
import { REQUESTED_WORK_KIND_QUESTION } from './requested-work-kind';
import { TASK_MEMORY_GATE_QUESTIONS } from './task-run-memory-distillation';
import type { TypeSafeQuestion } from './typesafe-judgment';

/**
 * Every decision Roomote asks a judgment model, for the admin decision
 * tester: the questions are the ones the code sends (imported, never
 * copied), and each comes with a synthetic sample state in the shape its
 * caller builds. Decisions whose options depend on the deployment (the
 * delegated task's model) are rendered from sample models and rules.
 */
export type JudgmentDecision = {
  id: string;
  label: string;
  description: string;
  questions: Record<string, TypeSafeQuestion>;
  sampleState: Record<string, unknown>;
  /** Shown beside the decision when Roomote asks it only in some setups. */
  note?: string;
};

const SAMPLE_MODELS: TaskModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    family: 'claude',
  },
  {
    id: 'anthropic/claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    family: 'claude',
  },
  { id: 'openai/gpt-5.6', displayName: 'GPT-5.6', family: 'gpt' },
];
const SAMPLE_ROUTING_RULES: CodingModelRoutingRule[] = [
  {
    modelId: 'anthropic/claude-opus-5-5',
    reasoningEffort: 'high',
    condition: 'the work is a database migration or schema change',
  },
  {
    modelId: 'openai/gpt-5.6',
    reasoningEffort: null,
    condition: 'the work only updates documentation or copy',
  },
];

const sampleTriageState: TaskCommunicationTriageState = {
  surface: 'slack',
  requesterIsPresent: false,
  silenceSinceRequesterLastHeard: '5_to_20_minutes',
  whatTheRequesterAskedFor: [
    'Fix the flaky checkout test in acme/web and open a PR.',
  ],
  whatTheRequesterWasAlreadyTold: [
    "On it: I'll look at the checkout test and report back.",
  ],
  task: { title: 'Fix flaky checkout test' },
  update: {
    kind: 'task_report',
    purpose: 'clarification',
    text: 'The test depends on the staging payment sandbox, which is down. Should I mock the payment client in the test, or wait for staging to come back?',
  },
};

/**
 * The single registry for production judgment decisions. Production callers'
 * `decision` values are typed from its keys, while the tester list below is
 * derived from the same definitions so a new registered decision cannot be
 * added to runtime without appearing in Settings > Models > Test decisions.
 */
export const JUDGMENT_DECISION_DEFINITIONS = {
  'fast-agent-post-turn-memory': {
    id: 'fast-agent-post-turn-memory',
    label: 'Memory check (chat turn)',
    description:
      'After a chat turn, whether it holds something durable worth saving to the conversation memory.',
    questions: MEMORY_GATE_QUESTIONS,
    sampleState: {
      request:
        'From now on, when you open PRs in acme/api, always add the #backend-reviews team as reviewers.',
      reply:
        "Got it. I'll add #backend-reviews as reviewers on every PR I open in acme/api.",
      saved_memories: '- Deploys go out from the release branch on Thursdays.',
    },
  },
  'task-run-memory-distillation': {
    id: 'task-run-memory-distillation',
    label: 'Memory check (task run)',
    description:
      "After a task's turn, whether its report holds something worth saving to Memory.",
    questions: TASK_MEMORY_GATE_QUESTIONS,
    sampleState: {
      request: 'Find out why the nightly export job fails and fix it.',
      report:
        'The export job failed because the warehouse credentials rotate every 30 days and the job reads them once at startup. I changed it to fetch credentials per run (PR #412). Anyone adding a scheduled job that talks to the warehouse should do the same.',
      turnTs: '2026-09-24T14:05:00Z',
      existing_memory: '',
    },
  },
  'unmentioned-thread-reply': {
    id: 'unmentioned-thread-reply',
    label: 'Reply addressee',
    description:
      'Whether an unmentioned reply in a thread is meant for Roomote.',
    questions: {
      addressee: REPLY_ADDRESSEE_QUESTION,
    },
    sampleState: {
      thread: {
        messages: [
          {
            author: 'reply author',
            text: '@Roomote can you check why the staging deploy is stuck?',
            mentionsRoomote: true,
            mentionsSomebodyElse: false,
          },
          {
            author: 'Roomote',
            text: 'The deploy is waiting on a failed migration. Want me to roll it back or retry it?',
            mentionsRoomote: false,
            mentionsSomebodyElse: false,
          },
        ],
      },
      reply: {
        author: 'reply author',
        text: 'retry it please',
        mentionsRoomote: false,
        mentionsSomebodyElse: false,
      },
    },
  },
  'fast-agent-task-communication-triage': {
    id: 'fast-agent-task-communication-triage',
    label: 'Task communication triage',
    description:
      'Whether a running task has something the requester needs to hear now.',
    questions: TASK_COMMUNICATION_QUESTIONS,
    sampleState: sampleTriageState,
  },
  'session-status-judgment': {
    id: 'session-status-judgment',
    label: 'Session status',
    description:
      'After Session activity, whether the user’s request is open, done, blocked, waiting for input, or unclear.',
    questions: SESSION_STATUS_JUDGMENT_QUESTIONS,
    sampleState: {
      objective: 'Fix the flaky checkout test and open a pull request.',
      recentMessages: [
        {
          role: 'user',
          text: 'Please fix the flaky checkout test and open a pull request.',
        },
        {
          role: 'assistant',
          text: 'The test is fixed, but the staging payment sandbox is unavailable. Should I mock the payment client or wait for staging to return?',
        },
      ],
      childTasks: [],
      goalStatus: null,
    },
    note: 'The Session status decision is not yet approved for the Roomote-trained model.',
  },
  'fast-agent-launch-model': {
    id: 'fast-agent-launch-model',
    label: "Delegated task's model",
    description:
      'Which model a delegated task should run on, from the request and the routing rules. Options are rendered from sample models and rules.',
    questions: {
      wantsNonDefaultModel: WANTS_NON_DEFAULT_MODEL_QUESTION,
      requestedModel: buildRequestedModelQuestion(SAMPLE_MODELS),
      routingRule: buildRoutingRuleQuestion(
        SAMPLE_ROUTING_RULES,
        new Map(SAMPLE_MODELS.map((model) => [model.id, model])),
      ),
    },
    sampleState: {
      defaultModel: describeDefaultModel(SAMPLE_MODELS[0]),
      work: 'Add a nullable `archived_at` column to the projects table and backfill it from the audit log.',
      latestRequest:
        'Can you add archived_at to projects and backfill it? Use Opus for this one.',
      earlierMessages: [],
    },
  },
  'channel-launch-gate': {
    id: 'channel-launch-gate',
    label: 'Channel launch criteria',
    description:
      "Whether a channel message meets the channel's auto-respond launch criteria, and repeats an incident already launched.",
    questions: {
      criteriaMet: CRITERIA_MET_QUESTION,
      duplicate: DUPLICATE_QUESTION,
    },
    sampleState: {
      launchCriteria: 'Production alerts about the payments service.',
      channel: {
        channelName: 'alerts-payments',
        authorDescription: 'PagerDuty (bot)',
        botMentioned: false,
        recentGateActivity: [
          {
            ageDescription: '12 minutes ago',
            decision: 'launched',
            messageSnippet:
              '[FIRING] payments-api error rate 4.1% (threshold 2%)',
          },
        ],
        messageText:
          '[FIRING] payments-api error rate 9.8% (threshold 2%), now also affecting refunds-worker',
      },
    },
    note: 'Roomote asks `duplicate` only when an earlier message in the channel launched work.',
  },
  'custom-automation-launch-gate': {
    id: 'custom-automation-launch-gate',
    label: 'Custom automation launch criteria',
    description:
      'Whether the evidence gathered for a custom automation satisfies its saved launch criteria.',
    questions: {
      criteriaMet: CUSTOM_AUTOMATION_LAUNCH_CRITERIA_QUESTION,
    },
    sampleState: {
      automationPrompt: 'Review payment API errors and report regressions.',
      launchCriteria: 'The payment API error rate is above 5%.',
      findingsReport:
        'The payment API error rate is 8% over the last 15 minutes, above the saved threshold.',
      report:
        'The payment API error rate is 8% over the last 15 minutes, above the saved threshold.',
      rawToolResults: [
        {
          integrationId: 'sentry',
          toolName: 'search_events',
          result: 'Payment API error rate: 8% over the last 15 minutes.',
        },
      ],
      recentResults: [],
    },
    note: 'Additional `run_when_*` questions are generated from each automation’s saved criteria.',
  },
  'requested-work-kind': {
    id: 'requested-work-kind',
    label: 'Requested work kind',
    description:
      'Whether a new task asks a question, wants a plan, or wants an implementation.',
    questions: { kind: REQUESTED_WORK_KIND_QUESTION },
    sampleState: {
      prompt:
        'Before we touch anything, can you write up how we would move session storage from Redis to Postgres, and what could break?',
    },
  },
  'agentmail-auto-reply': {
    id: 'agentmail-auto-reply',
    label: 'Automatic email reply',
    description: 'Whether inbound email is an automatic reply.',
    questions: { autoReply: AGENTMAIL_AUTO_REPLY_QUESTION },
    sampleState: {
      email: {
        from: 'Dana Whitfield <dana@example.com>',
        subject: 'Automatic reply: Q3 planning notes',
        body: "Thanks for your email. I'm out of the office until Monday, October 6 with limited access to email. For anything urgent, please contact ops@example.com.",
      },
    },
  },
  'integration-tool-auto-evaluation': {
    id: 'integration-tool-auto-evaluation',
    label: 'Tool call auto-approval',
    description:
      'Whether a paused integration tool call is routine enough to run without asking.',
    questions: INTEGRATION_TOOL_AUTO_QUESTIONS,
    sampleState: {
      call: {
        integration: 'linear',
        tool: 'create_comment',
        description: 'Comment on a Linear issue.',
        arguments: {
          issueId: 'ENG-1423',
          body: 'Fixed in PR #412; deploying Thursday.',
        },
      },
      userRequest: 'Let the Linear issue know the fix is merged.',
      readContent: null,
      deploymentGuidance: 'Comments on our own Linear issues are routine.',
    },
  },
} satisfies Record<string, JudgmentDecision>;

export type JudgmentDecisionId = keyof typeof JUDGMENT_DECISION_DEFINITIONS;

export const JUDGMENT_DECISION_CATALOG: JudgmentDecision[] = Object.values(
  JUDGMENT_DECISION_DEFINITIONS,
);
