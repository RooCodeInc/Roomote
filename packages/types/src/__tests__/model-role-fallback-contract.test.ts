import {
  MODEL_FALLBACK_AGENT_ROLES,
  MODEL_FALLBACK_RUNTIME_COVERAGE,
  TASK_MODEL_ROLES,
  TASK_MODEL_ROLE_DESCRIPTORS,
} from '../index';

describe('model role fallback contract', () => {
  it('declares unique fallback env vars and covered runtimes for every role', () => {
    const primary = new Set<string>();
    const fallback = new Set<string>();
    for (const role of TASK_MODEL_ROLES) {
      const descriptor = TASK_MODEL_ROLE_DESCRIPTORS[role];
      primary.add(descriptor.modelEnvVar);
      primary.add(descriptor.reasoningEnvVar);
      expect(descriptor.fallbackRuntime.length).toBeGreaterThan(0);
      for (const runtime of descriptor.fallbackRuntime) {
        expect(MODEL_FALLBACK_RUNTIME_COVERAGE[runtime]).toBeDefined();
      }
      expect(fallback.has(descriptor.fallbackModelEnvVar)).toBe(false);
      expect(fallback.has(descriptor.fallbackReasoningEnvVar)).toBe(false);
      fallback.add(descriptor.fallbackModelEnvVar);
      fallback.add(descriptor.fallbackReasoningEnvVar);
    }
    for (const envVar of fallback) expect(primary.has(envVar)).toBe(false);
  });

  it('maps every subagent fallback role', () => {
    const mappedRoles = new Set<string>(
      Object.values(MODEL_FALLBACK_AGENT_ROLES),
    );
    for (const role of TASK_MODEL_ROLES) {
      if (
        (
          TASK_MODEL_ROLE_DESCRIPTORS[role].fallbackRuntime as readonly string[]
        ).includes('subagent')
      ) {
        expect(mappedRoles.has(role)).toBe(true);
      }
    }
  });
});
