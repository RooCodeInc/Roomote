import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const REPO_LOCAL_SKILL_DIRECTORIES = [
  ['.agents', 'skills'],
  ['.claude', 'skills'],
] as const;

export interface RepoLocalSkill {
  repoName: string;
  repoFullName?: string;
  skillName: string;
  skillPath: string;
  skillDirPath: string;
  skillRootPath: string;
}

interface RepoLocalSkillInvocation {
  invocationName: string;
  repoLocalSkill: RepoLocalSkill;
}

export async function discoverRepoLocalSkills({
  repoPaths,
  repoFullNamesByDir,
}: {
  repoPaths: Record<string, string>;
  repoFullNamesByDir?: Record<string, string>;
}): Promise<RepoLocalSkill[]> {
  const repoLocalSkills: RepoLocalSkill[] = [];

  for (const [repoName, repoPath] of Object.entries(repoPaths)) {
    for (const relativeDir of REPO_LOCAL_SKILL_DIRECTORIES) {
      const skillRootPath = path.join(repoPath, ...relativeDir);
      let skillEntries: Dirent[];

      try {
        skillEntries = await fs.readdir(skillRootPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of skillEntries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skillDirPath = path.join(skillRootPath, entry.name);
        const skillPath = path.join(skillDirPath, 'SKILL.md');

        try {
          await fs.access(skillPath);
        } catch {
          continue;
        }

        repoLocalSkills.push({
          repoName,
          repoFullName: repoFullNamesByDir?.[repoName],
          skillName: entry.name,
          skillPath,
          skillDirPath,
          skillRootPath,
        });
      }
    }
  }

  return repoLocalSkills.sort((left, right) => {
    if (left.repoName !== right.repoName) {
      return left.repoName.localeCompare(right.repoName);
    }

    if (left.skillName !== right.skillName) {
      return left.skillName.localeCompare(right.skillName);
    }

    if (left.skillRootPath !== right.skillRootPath) {
      return left.skillRootPath.localeCompare(right.skillRootPath);
    }

    return left.skillPath.localeCompare(right.skillPath);
  });
}

export function getRepoLocalSkillRootPaths(
  repoLocalSkills?: RepoLocalSkill[],
): string[] {
  return [
    ...new Set((repoLocalSkills ?? []).map((skill) => skill.skillRootPath)),
  ]
    .filter((rootPath) => rootPath.trim().length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function normalizeRepoLocalSkillInvocationSegment(
  value: string,
  fallback: string,
): string {
  const normalized = value
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');

  return normalized.length > 0 ? normalized : fallback;
}

function buildRepoQualifiedInvocationName(skill: RepoLocalSkill): string {
  const repoSegment = normalizeRepoLocalSkillInvocationSegment(
    skill.repoName,
    'repo',
  );
  const skillSegment = normalizeRepoLocalSkillInvocationSegment(
    skill.skillName,
    'skill',
  );

  return `${repoSegment}.${skillSegment}`;
}

export function getRepoLocalSkillInvocations(
  repoLocalSkills?: RepoLocalSkill[],
): RepoLocalSkillInvocation[] {
  if (!repoLocalSkills?.length) {
    return [];
  }

  const skillRepos = new Map<string, Set<string>>();

  for (const repoLocalSkill of repoLocalSkills) {
    const skillName = repoLocalSkill.skillName.trim();

    if (skillName.length === 0) {
      continue;
    }

    const repoKey =
      repoLocalSkill.repoFullName?.trim() ||
      repoLocalSkill.repoName.trim() ||
      repoLocalSkill.skillDirPath;
    const reposForSkill = skillRepos.get(skillName) ?? new Set<string>();
    reposForSkill.add(repoKey);
    skillRepos.set(skillName, reposForSkill);
  }

  const invocations = new Map<string, RepoLocalSkillInvocation>();

  for (const repoLocalSkill of repoLocalSkills) {
    const skillName = repoLocalSkill.skillName.trim();

    if (skillName.length === 0) {
      continue;
    }

    const invocationName =
      (skillRepos.get(skillName)?.size ?? 0) > 1
        ? buildRepoQualifiedInvocationName(repoLocalSkill)
        : skillName;

    if (invocations.has(invocationName)) {
      continue;
    }

    invocations.set(invocationName, {
      invocationName,
      repoLocalSkill,
    });
  }

  return [...invocations.values()];
}
