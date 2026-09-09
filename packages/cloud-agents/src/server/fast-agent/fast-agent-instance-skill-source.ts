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
}): FastAgentSkillSummary {
  return {
    id: `instance:${skill.id}`,
    name: skill.name,
    invocation: skill.name,
    description: skill.description,
    source: 'instance',
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
    const resourceIsSafe =
      resource === 'SKILL.md' ||
      (resource.endsWith('.md') &&
        !resource.startsWith('/') &&
        !resource.includes('\\') &&
        resource
          .split('/')
          .every((segment) => segment && segment !== '.' && segment !== '..'));
    if (!match?.[1] || !resourceIsSafe) {
      throw new Error('Unknown instance skill or resource.');
    }
    const skill = await getCustomSkill(this.userId, match[1]);
    if (!skill) throw new Error('Unknown instance skill.');
    const storedResource = skill.resources.find(
      (candidate) => candidate.path === resource && resource.endsWith('.md'),
    );
    if (resource !== 'SKILL.md' && !storedResource) {
      throw new Error('Unknown instance skill or resource.');
    }
    const content = storedResource
      ? Buffer.from(storedResource.contentBase64, 'base64').toString('utf8')
      : (skill.document ?? renderManualSkillMarkdown(skill));
    const resources = [
      'SKILL.md',
      ...skill.resources
        .map((candidate) => candidate.path)
        .filter((path) => path.endsWith('.md')),
    ].sort();
    return {
      ...summarize(skill),
      content,
      byteLength: Buffer.byteLength(content, 'utf8'),
      resource,
      resources,
    };
  }
}
