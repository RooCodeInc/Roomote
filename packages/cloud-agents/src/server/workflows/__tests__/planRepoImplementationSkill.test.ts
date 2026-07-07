import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function readPlanSkill(): string {
  return fs.readFileSync(
    path.resolve(
      thisDirPath,
      '../skills/standard/plan-repo-implementation/SKILL.md',
    ),
    'utf8',
  );
}

describe('plan-repo-implementation skill', () => {
  it('makes plan artifact publication the canonical final delivery path', () => {
    const skillContent = readPlanSkill();

    expect(skillContent).toContain(
      'call the artifact-management mechanism with action `create_plan`',
    );
    expect(skillContent).toContain('before any final user-facing closeout');
    expect(skillContent).toContain(
      'Use the returned view URL as the canonical plan link',
    );
    expect(skillContent).toContain(
      'instead of reproducing the complete plan as the primary chat answer',
    );
    expect(skillContent).not.toContain(
      'The final plan exists as a reusable artifact or equivalent durable output.',
    );
  });

  it('keeps planning conversational while holding the final plan to a decision-complete bar', () => {
    const skillContent = readPlanSkill();

    expect(skillContent).toContain(
      'chat your way to a decision-complete implementation plan',
    );
    expect(skillContent).toContain(
      'Keep asking until you can clearly state the goal, success criteria, audience, scope boundaries, constraints, current state, and the key preferences or tradeoffs that shape the work.',
    );
    expect(skillContent).toContain(
      'Ask only about goals, success criteria, audience, scope boundaries, constraints, current state, or tradeoffs that exploration cannot answer.',
    );
    expect(skillContent).toContain(
      'Keep asking until the implementation spec is decision complete: approach, interfaces, data flow, edge cases and failure modes, testing and acceptance criteria, rollout and monitoring expectations, and any migrations or compatibility constraints.',
    );
    expect(skillContent).toContain(
      'If high-impact ambiguity remains, do not finalize the plan yet. Ask more questions instead of guessing.',
    );
    expect(skillContent).toContain(
      'Use conversation to reach a better plan, not just to announce one.',
    );
    expect(skillContent).toContain(
      "keep the user informed according to the active surface's communication rules while you do it.",
    );
    expect(skillContent).not.toContain(
      'Silent exploration between turns is allowed and encouraged',
    );
    expect(skillContent).not.toContain(
      'Prefer silent exploration over premature questioning',
    );
  });

  it('hands off explicit build requests through a same-turn implement-changes skill load', () => {
    const skillContent = readPlanSkill();

    expect(skillContent).toContain(
      'load the `implement-changes` skill with the skill tool in that same turn, acknowledge briefly, and end the turn.',
    );
    expect(skillContent).toContain(
      'The runtime automatically continues into a writable implementation turn where you proceed under that workflow. This handoff is mandatory.',
    );
    expect(skillContent).toContain(
      'Load the `implement-changes` skill in that same turn and end the turn; the runtime continues into a writable implementation turn under that workflow.',
    );
    expect(skillContent).not.toContain(
      'stop this planning-only path, read `implement-changes`',
    );
  });

  it('never pins same-turn edit denials or redirects the user to a new task', () => {
    const skillContent = readPlanSkill();

    expect(skillContent).toContain(
      'Never interpret a same-turn edit denial as a permanent restriction, and never redirect the user to start a new task for the implementation.',
    );
    expect(skillContent).toContain(
      'Edit denials during the current planning turn are expected and temporary; never treat them as a permanent restriction and never redirect the user to a new task.',
    );
    expect(skillContent).toContain(
      'repository-tracked state must stay unchanged; keep scratch files and notes in `/tmp`.',
    );
  });
});
