import {
  formatUserCallableSkillsPage,
  listUserCallableFastAgentSkills,
} from '@roomote/cloud-agents/server';

export async function buildSkillsCommandReply(input: {
  userId: string;
  page: number;
  command: string;
}): Promise<string> {
  return formatUserCallableSkillsPage({
    catalog: await listUserCallableFastAgentSkills(input.userId),
    page: input.page,
    command: input.command,
  });
}
