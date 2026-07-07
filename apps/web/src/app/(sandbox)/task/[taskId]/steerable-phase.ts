export function isSteerablePhase(phase: string | null): boolean {
  return (
    phase === 'running' ||
    phase === 'waiting_for_user_input' ||
    phase === 'waiting_for_prompt'
  );
}
