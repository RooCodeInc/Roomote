import { describe, expect, it } from 'vitest';

import { CRITERIA_MET_QUESTION } from '../channel-launch-gate';
import { MEMORY_GATE_QUESTIONS } from '../fast-agent/fast-agent-post-turn-memory';
import { TASK_COMMUNICATION_QUESTIONS } from '../fast-agent/fast-agent-task-communication-triage';
import {
  JUDGMENT_DECISION_CATALOG,
  JUDGMENT_DECISION_DEFINITIONS,
} from '../judgment-decision-catalog';
import {
  CUSTOM_AUTOMATION_LAUNCH_CRITERIA_QUESTION,
  REPLY_ADDRESSEE_QUESTION,
  SESSION_STATUS_JUDGMENT_QUESTIONS,
} from '../judgment-questions';

describe('JUDGMENT_DECISION_CATALOG', () => {
  it('uses the question objects the callers send, not copies', () => {
    const byId = Object.fromEntries(
      JUDGMENT_DECISION_CATALOG.map((decision) => [decision.id, decision]),
    );
    expect(byId['fast-agent-post-turn-memory']?.questions).toBe(
      MEMORY_GATE_QUESTIONS,
    );
    expect(byId['fast-agent-task-communication-triage']?.questions).toBe(
      TASK_COMMUNICATION_QUESTIONS,
    );
    expect(byId['unmentioned-thread-reply']?.questions.addressee).toBe(
      REPLY_ADDRESSEE_QUESTION,
    );
    expect(byId['channel-launch-gate']?.questions.criteriaMet).toBe(
      CRITERIA_MET_QUESTION,
    );
    expect(byId['session-status-judgment']?.questions).toBe(
      SESSION_STATUS_JUDGMENT_QUESTIONS,
    );
    expect(byId['custom-automation-launch-gate']?.questions.criteriaMet).toBe(
      CUSTOM_AUTOMATION_LAUNCH_CRITERIA_QUESTION,
    );
  });

  it('keeps session status outcome boundaries explicit', () => {
    expect(SESSION_STATUS_JUDGMENT_QUESTIONS.outcome.instructions).toContain(
      'Exactly 4 days qualifies; less than 4 days does not trigger this override.',
    );
    expect(SESSION_STATUS_JUDGMENT_QUESTIONS.outcome.instructions).toContain(
      'Manual-status precedence:',
    );
    expect(SESSION_STATUS_JUDGMENT_QUESTIONS.outcome.instructions).toContain(
      'All three authoritative signals are required',
    );
    expect(SESSION_STATUS_JUDGMENT_QUESTIONS.outcome.criteria).toEqual({
      open: 'The request is still being worked on, and Roomote can continue without a concrete answer, decision, or action from the user. Active Roomote-owned work remains open even if a PR already exists; use needs_input only when a user answer, decision, review, approval, or verification is required before the next step.',
      done: 'The requested answer or work was actually delivered, with no unfinished promise or active child task, or the inactivity precedence rule applies. For a user-requested task whose full objective was to open a PR, an actually created PR can complete the request even while that PR remains open. A current manual status or live-work safeguard still prevents an automatic done outcome.',
      blocked:
        'The requested work cannot continue because of a real external dependency or failure that needs follow-up; use needs_input instead when a user answer, decision, or action is required.',
      needs_input:
        'Roomote is waiting for a concrete answer, decision, review, approval, verification, or other action from the user before it can continue. This includes a settled automation-originated handoff with a Roomote-created open PR awaiting user review, but never a PR by itself.',
      unclear:
        'The visible request and results do not provide enough evidence to choose another outcome confidently.',
    });
  });

  it('derives the tester catalog from the production decision registry', () => {
    expect(JUDGMENT_DECISION_CATALOG).toEqual(
      Object.values(JUDGMENT_DECISION_DEFINITIONS),
    );
    for (const [id, decision] of Object.entries(
      JUDGMENT_DECISION_DEFINITIONS,
    )) {
      expect(decision.id).toBe(id);
    }
  });

  it('has unique ids, a sample state, and well-formed questions for every decision', () => {
    const ids = JUDGMENT_DECISION_CATALOG.map((decision) => decision.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const decision of JUDGMENT_DECISION_CATALOG) {
      expect(Object.keys(decision.sampleState).length).toBeGreaterThan(0);
      const entries = Object.entries(decision.questions);
      expect(entries.length).toBeGreaterThan(0);
      for (const [, question] of entries) {
        expect(question.instructions.length).toBeGreaterThan(0);
        if (question.type === 'choice') {
          expect(Object.keys(question.criteria).length).toBeGreaterThanOrEqual(
            2,
          );
        }
        if (question.type === 'score') {
          expect(question.criteria.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("renders the delegated task's model options from the sample models and rules", () => {
    const launch = JUDGMENT_DECISION_CATALOG.find(
      (decision) => decision.id === 'fast-agent-launch-model',
    );
    expect(
      Object.keys(launch?.questions.requestedModel?.criteria ?? {}),
    ).toEqual([
      'model_1',
      'model_2',
      'model_3',
      'none',
      'capability_request',
      'default_request',
    ]);
    expect(Object.keys(launch?.questions.routingRule?.criteria ?? {})).toEqual([
      'model_rule_1',
      'model_rule_2',
      'default_model',
      'unclear',
    ]);
  });
});
