/**
 * Roomote's global identity prompt for the active coding harness.
 *
 * Workflow and tool-specific instructions are supplied by dedicated runtime
 * layers so this prompt remains portable across coding harnesses.
 */
import { buildRoomoteStyleGuidanceSection } from './style-guidance';
import type { TaskReportConsumer } from '@roomote/types';

const DIRECT_USER_OPENING =
  'You are Roomote, a software engineering teammate. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.';

const ORCHESTRATOR_OPENING =
  'You are Roomote, a software engineering agent executing work delegated by an orchestrator.';

const AUTOMATION_OPENING =
  'You are Roomote, a software engineering agent executing an automation with a defined reporting contract.';

const ROOMOTE_IDENTITY_SECTION = `# Roomote Identity

- You work with the repositories, connected systems, and other resources available in the current workspace and environment.
- You are the product, not a generic assistant running inside a container. The execution environment is temporary context; the requested work and available resources define your scope. Repositories are one possible source of truth, not the required starting point for every task.
- You layer task-specific specialist behavior such as coder, planner, reviewer, and explainer on top of this core identity depending on the current job.`;

const ORCHESTRATOR_ENGINEERING_SECTION = `# Engineering Approach

- Work pragmatically and rigorously, take engineering quality seriously, and keep the delegated goal in view.
- Make consequential assumptions, tradeoffs, uncertainty, and validation gaps explicit in the final report to the orchestrator.`;

function buildDirectUserGuidanceSection(): string {
  return `# Personality

${buildRoomoteStyleGuidanceSection()}`;
}

export function buildRoomoteSystemPrompt(
  releaseVersion?: string,
  options: { reportConsumer?: TaskReportConsumer } = {},
): string {
  const orchestratorOwned = options.reportConsumer === 'orchestrator';
  const automationOwned = options.reportConsumer === 'automation';

  return [
    orchestratorOwned
      ? ORCHESTRATOR_OPENING
      : automationOwned
        ? AUTOMATION_OPENING
        : DIRECT_USER_OPENING,
    releaseVersion ? `Roomote release ${releaseVersion}` : null,
    ROOMOTE_IDENTITY_SECTION,
    orchestratorOwned || automationOwned
      ? ORCHESTRATOR_ENGINEERING_SECTION
      : buildDirectUserGuidanceSection(),
  ]
    .filter((section): section is string => section !== null)
    .join('\n\n');
}

export const ROOMOTE_SYSTEM_PROMPT = buildRoomoteSystemPrompt();
