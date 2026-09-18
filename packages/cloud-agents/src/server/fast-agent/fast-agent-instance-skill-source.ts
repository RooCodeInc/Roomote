import { getCustomSkill, listCustomSkills } from '@roomote/db/server';
import { renderManualSkillMarkdown } from '@roomote/types';

import type {
  FastAgentSkillDocument,
  FastAgentSkillListResult,
  FastAgentSkillQuery,
  FastAgentSkillSummary,
} from './fast-agent-skill-store';

function summarize(skill: {
  id: string;
  name: string;
  description: string;
  version: number;
}): FastAgentSkillSummary {
  return {
    id: `instance:${skill.id}`,
    name: skill.name,
    invocation: skill.name,
    description: skill.description,
    source: 'instance',
    version: skill.version,
  };
}

export class RemoteFastAgentInstanceSkillSource {
  constructor(private readonly userId: string) {}

  async list(
    query: FastAgentSkillQuery = {},
  ): Promise<FastAgentSkillListResult> {
    // Reauthorize and reload on every call, including within one conversation.
    const skills = await listCustomSkills(this.userId);
    return {
      skills: skills
        .filter((skill) => !query.name || skill.name === query.name)
        .map(summarize),
      warnings: [],
    };
  }

  async read(
    id: string,
    resource = 'SKILL.md',
  ): Promise<FastAgentSkillDocument> {
    const match =
      /^instance:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(
        id,
      );
    if (!match?.[1] || resource !== 'SKILL.md') {
      throw new Error('Unknown instance skill or resource.');
    }
    const skill = await getCustomSkill(this.userId, match[1]);
    if (!skill) throw new Error('Unknown instance skill.');
    const content = renderManualSkillMarkdown(skill);
    return {
      ...summarize(skill),
      content,
      byteLength: Buffer.byteLength(content, 'utf8'),
      resource,
      resources: ['SKILL.md'],
    };
  }
}
