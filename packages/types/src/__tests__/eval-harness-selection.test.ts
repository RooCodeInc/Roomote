import { describe, expect, it } from 'vitest';

import { resolveEvalHarnessSelection } from '../eval-harness-selection';

const OPENCODE_MODEL = 'provider-id/model-id';

describe('resolveEvalHarnessSelection', () => {
  it('returns an empty selection when nothing is requested', () => {
    expect(resolveEvalHarnessSelection({})).toEqual({ ok: true });
  });

  it('rejects a model that is not in OpenCode provider/model format', () => {
    const result = resolveEvalHarnessSelection({ model: 'gpt-5.5' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('provider/model format');
    }
  });

  it('infers the OpenCode harness from a model override', () => {
    expect(resolveEvalHarnessSelection({ model: OPENCODE_MODEL })).toEqual({
      ok: true,
      harness: 'opencode-server',
      harnessModelOverrides: { 'opencode-server': OPENCODE_MODEL },
    });
  });

  it('pins an explicit OpenCode harness with a model override', () => {
    expect(
      resolveEvalHarnessSelection({
        harness: 'opencode-server',
        model: OPENCODE_MODEL,
      }),
    ).toEqual({
      ok: true,
      harness: 'opencode-server',
      harnessModelOverrides: { 'opencode-server': OPENCODE_MODEL },
    });
  });

  it('pins an explicit harness even without a model', () => {
    expect(resolveEvalHarnessSelection({ harness: 'opencode-server' })).toEqual(
      { ok: true, harness: 'opencode-server' },
    );
  });

  it('rejects an unknown harness value', () => {
    const result = resolveEvalHarnessSelection({ harness: 'custom-harness' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown harness');
    }
  });

  it('rejects a non-OpenCode-format model on the OpenCode harness', () => {
    const result = resolveEvalHarnessSelection({
      harness: 'opencode-server',
      model: 'gpt-5.5',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('provider/model format');
    }
  });

  it('accepts --reasoning on the OpenCode harness', () => {
    expect(
      resolveEvalHarnessSelection({
        harness: 'opencode-server',
        reasoningEffort: 'xhigh',
      }),
    ).toEqual({ ok: true, harness: 'opencode-server' });
  });

  it('accepts --reasoning when the OpenCode harness is inferred from the model', () => {
    expect(
      resolveEvalHarnessSelection({
        model: OPENCODE_MODEL,
        reasoningEffort: 'high',
      }),
    ).toEqual({
      ok: true,
      harness: 'opencode-server',
      harnessModelOverrides: { 'opencode-server': OPENCODE_MODEL },
    });
  });
});
