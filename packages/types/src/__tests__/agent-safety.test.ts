import { createHash } from 'node:crypto';
import {
  AGENT_SAFETY,
  AGENT_SAFETY_STOP_CODE,
  AgentSafetyPass,
  canonicalSafetyJson,
  isAgentSafetyStop,
} from '../agent-safety';
import { classifyModelFallbackTrigger } from '../model-fallbacks';

const pass = () =>
  new AgentSafetyPass(
    (text) => createHash('sha256').update(text).digest('hex'),
    0,
  );
const call = (id: number, result: unknown = '') => ({
  id: String(id),
  name: 'grep',
  args: { pattern: 'missing snapshot', path: 'test' },
  result,
});

describe('agent safety pass', () => {
  it('stops the original thousand-empty-search loop at the fifth unique completion', () => {
    const guard = pass();
    for (let id = 0; id < 1_000; id++)
      expect(guard.completed(call(id))).toBe(
        id < 4 ? undefined : 'identical_tool_loop',
      );
  });
  it('canonicalizes arguments and deduplicates repeated/out-of-order events', () => {
    const guard = pass();
    for (let index = 0; index < 1_000; index++)
      expect(guard.completed(call(1))).toBeUndefined();
    for (let id = 2; id < 5; id++) {
      expect(
        guard.completed({
          ...call(id),
          args: { path: 'test', pattern: 'missing snapshot' },
        }),
      ).toBeUndefined();
      expect(guard.completed(call(1))).toBeUndefined();
    }
    expect(guard.completed(call(5))).toBe('identical_tool_loop');
    expect(canonicalSafetyJson({ a: 1, b: 2 })).toBe(
      canonicalSafetyJson({ b: 2, a: 1 }),
    );
  });
  it('resets repetition on changed results or arguments, but still caps the pass', () => {
    const guard = pass();
    for (let id = 0; id < AGENT_SAFETY.passTools; id++)
      expect(guard.completed(call(id, { value: id }))).toBe(
        id === AGENT_SAFETY.passTools - 1 ? 'pass_tool_limit' : undefined,
      );
  });
  it('permits bounded status polling, never arbitrary search or shell exemptions', () => {
    const guard = pass();
    for (let id = 0; id < 20; id++)
      expect(
        guard.completed({
          id: String(id),
          name: 'roomote_manage_tasks',
          args: { action: 'get_updates' },
          result: [],
        }),
      ).toBe(id === 19 ? 'identical_tool_loop' : undefined);
  });
  it('counts unique model steps and has an activity-independent deadline', () => {
    const guard = pass();
    for (let id = 0; id < 100; id++) {
      const expected = id === 99 ? 'pass_step_limit' : undefined;
      expect(guard.step(String(id))).toBe(expected);
      expect(guard.step(String(id))).toBe(expected);
    }
    expect(pass().checkTime(AGENT_SAFETY.passTimeoutMs)).toBe(
      'pass_time_limit',
    );
  });
  it('never selects provider fallback for safety errors, even if wrapped as retryable', () => {
    const error = {
      data: {
        isRetryable: true,
        statusCode: 503,
        responseBody: JSON.stringify({
          error: { code: AGENT_SAFETY_STOP_CODE },
        }),
      },
    };
    expect(isAgentSafetyStop(error)).toBe(true);
    expect(
      classifyModelFallbackTrigger(error, { retriesUsed: 100 }),
    ).toBeNull();
  });
});
