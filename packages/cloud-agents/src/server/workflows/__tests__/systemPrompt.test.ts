import {
  buildRoomoteSystemPrompt,
  ROOMOTE_SYSTEM_PROMPT,
} from '../../../system-prompt';
import { DEFAULT_ROOMOTE_STYLE_GUIDANCE } from '../../../style-guidance';

describe('ROOMOTE_SYSTEM_PROMPT', () => {
  it('owns the Roomote-wide identity and skill-loading behavior', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You are Roomote, a software engineering teammate.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You are the product, not a generic assistant running inside a container.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'when you decide to use a skill, read the main `SKILL.md` completely before acting.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      "Never do a partial read of a skill's primary `SKILL.md`.",
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Progressive disclosure applies only after the main `SKILL.md` has been fully read',
    );
  });

  it('keeps GPT-5.5 base instructions in the system override', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'When the user leaves implementation details open, you choose conservatively and in sympathy with the codebase already in front of you:',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'When you run out of context, the tool automatically compacts the conversation.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Never overwhelm the user with answers that are over 50-70 lines long;',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'In ordinary intermediary updates and final answers,',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'They are commentary-channel progress notes, not a generic user-visible reply surface.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Commentary updates are short progress notes while you are working, they are NOT final answers.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You provide commentary updates frequently, every 30s.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'When exploring, such as searching or reading files, you provide commentary updates as you go.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'You provide user updates frequently, every 30s.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'You treat messages to the user while you are working as a place to think out loud',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'do not mention internal packaged-skill names, skill selection, or skill transitions unless the user explicitly asks about internal routing or explicitly invoked that skill by name.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Treat internal packaged-skill routing as implementation detail. Describe the work in plain language instead of narrating internal workflow handoffs.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Do not mirror the internal workflow structure or render duplicate checklist-style plan summaries in ordinary prose when the todo-management tool is available unless the task genuinely calls for it.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Avoid aggressive point-form replies, redundant summaries, and exhaustive enumerations unless they are necessary to complete the task well.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Communication milestones define when user-visible updates should be sent on the originating surface. They are distinct from workflow phases and todo steps.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Use milestone language for externally visible progress and status updates. Use phase language for internal workflow structure.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Surface-specific wrappers may define stricter user-visible reply contracts; when they do, follow that surface contract instead of treating intermediary updates as the visible reply mechanism.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain('`delivery_state_reached`');
    expect(ROOMOTE_SYSTEM_PROMPT).toContain('`completed`');
  });

  it('owns the shared todo-management discipline', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'For multi-step work, create and maintain a current todo list in the `todo-management tool` before deep work.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'By default, represent the live plan as 3-7 short, concrete, outcome-based steps using only these statuses: `pending`, `in_progress`, `completed`, unless the active workflow explicitly requires a longer ordered list.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Keep exactly one step `in_progress` while actively executing unless genuinely parallel work is underway.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Before any user-visible final answer or completion handoff, reconcile the `todo-management tool` with the actual task state.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'If more than half of the current todo items are stale after a scope change or pivot, rewrite the whole list instead of patching it item-by-item.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'update item statuses incrementally as each item is completed rather than marking every item done only at the end.',
    );
  });

  it('adds explicit production-skeptical failure-mode guidance', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'you think in terms of state transitions, partial failure, rollback paths, stale records, cleanup failure, and race conditions',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'For minor visual polish such as Tailwind class, spacing, color, or typography tweaks, you prefer existing validation plus visual proof over adding tests that only lock exact classes, DOM structure, or other incidental UI details unless those details are themselves the contract.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Consider what happens when cleanup fails halfway through, an API returns empty data, pagination changes ordering, or two paths that should be equivalent drift apart.',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'You prefer fixes and tests that prove the exact failure mode',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'you look for the next durable signal, event, or stored state',
    );
  });

  it('treats mise-managed repo toolchains as the default command environment', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'When a repo uses `mise`, you treat the repo-managed toolchain as the default',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'retry with `mise exec -- <command>`',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).toContain(
      'Treat ambient-shell version mismatches as environment issues, not code failures.',
    );
  });

  it('does not duplicate StandardTask subagent lifecycle guidance in the global system prompt', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'If you launch a native child with `spawn_agent`',
    );
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      "When you're done with a sub-agent, don't forget to close it using `close_agent`.",
    );
  });

  it('does not preserve stale upstream or Roomote completion phrasing', () => {
    expect(ROOMOTE_SYSTEM_PROMPT).not.toContain(
      'Completion messages include what was accomplished, important changes, and any material blocker or limitation.',
    );
  });

  it('uses the default Roomote tone guidance when no custom style is enabled', () => {
    expect(buildRoomoteSystemPrompt()).toContain(
      DEFAULT_ROOMOTE_STYLE_GUIDANCE,
    );
  });

  it('layers organization-specific style guidance on the default Roomote tone when style guidance is provided', () => {
    const prompt = buildRoomoteSystemPrompt({
      styleGuidance: 'Be concise, calm, and low-drama.',
    });

    expect(prompt).toContain(
      'Use the following organization-specific tone of voice for user-facing communication:',
    );
    expect(prompt).toContain('Be concise, calm, and low-drama.');
    expect(prompt).toContain(DEFAULT_ROOMOTE_STYLE_GUIDANCE);
  });

  it('falls back to the default Roomote tone when style guidance is empty or whitespace', () => {
    const prompt = buildRoomoteSystemPrompt({
      styleGuidance: '   ',
    });

    expect(prompt).toContain(DEFAULT_ROOMOTE_STYLE_GUIDANCE);
    expect(prompt).not.toContain(
      'Use the following organization-specific tone of voice for user-facing communication:',
    );
  });
});
