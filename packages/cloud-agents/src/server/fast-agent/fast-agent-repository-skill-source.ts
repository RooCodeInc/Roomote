import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createGitHubTokenWithMetadata } from '@roomote/auth';
import { buildAdoAuthorizationHeader, resolveAdoToken } from '@roomote/ado';
import { resolveBitbucketAuth } from '@roomote/bitbucket';
import {
  and,
  db,
  environmentRepositoryMappings,
  eq,
  inArray,
  repositories,
} from '@roomote/db/server';
import { resolveGiteaToken, resolveGiteaUsername } from '@roomote/gitea';
import { resolveGitLabToken } from '@roomote/gitlab';
import {
  stripCloneUrlUserInfo,
  type SourceControlProvider,
} from '@roomote/types';

import {
  getFastAgentSkillDescription,
  type FastAgentRepositorySkillSource,
  type FastAgentSkillDocument,
  type FastAgentSkillListResult,
  type FastAgentSkillSummary,
} from './fast-agent-skill-store';
import { FAST_AGENT_SPILL_MAX_FILE_BYTES } from './fast-agent-spill-store';

const execFileAsync = promisify(execFile);
const REPOSITORY_SKILL_FETCH_TIMEOUT_MS = 60_000;
const REPOSITORY_SKILL_FETCH_CONCURRENCY = 4;
const REPOSITORY_SKILL_MAX_REPOSITORIES = 8;
const REPOSITORY_SKILL_GIT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const REPOSITORY_SKILL_MAX_FILES = 256;
const REPOSITORY_SKILL_MAX_SKILLS = 128;
const REPOSITORY_SKILL_PATH_MAX_CHARS = 1_024;
const REPOSITORY_SKILL_ROOT_PATTERN =
  /^(\.agents|\.claude)\/skills\/([A-Za-z0-9._-]+)\/(.+)$/u;

export type RepositorySkillRepository = {
  cloneUrl: string;
  defaultBranch: string;
  environmentIds: string[];
  fullName: string;
  githubRepoId: number | null;
  id: string;
  installationId: string | null;
  sourceControlProvider: SourceControlProvider;
};

type RepositorySkillCredential =
  | { authorizationHeader: string }
  | { token: string; username: string };

type RepositorySkillResource = {
  byteLength: number;
  path: string;
  resource: string;
};

export type RepositorySkillRecord = {
  description: string;
  environmentIds: string[];
  id: string;
  gitEnvironment: NodeJS.ProcessEnv;
  invocation: string;
  mainContent: string;
  name: string;
  repository: string;
  repositoryDirectory: string;
  resources: Map<string, RepositorySkillResource>;
  revision: string;
};

export type RepositorySkillSnapshot = {
  directory: string;
  records: RepositorySkillRecord[];
};

type FastAgentRepositorySkillSourceOptions = {
  allowedEnvironmentIds: string[];
  loadSnapshot?: (
    repository: RepositorySkillRepository,
  ) => Promise<RepositorySkillSnapshot>;
  resolveRepositories?: (
    environmentId?: string,
  ) => Promise<RepositorySkillRepository[]>;
};

function repositorySkillId(
  repositoryId: string,
  root: string,
  name: string,
): string {
  return `repository:${repositoryId}:${root}:${name}`;
}

function normalizeInvocationSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
  return normalized || fallback;
}

async function runGit(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: REPOSITORY_SKILL_GIT_OUTPUT_LIMIT_BYTES,
    timeout: REPOSITORY_SKILL_FETCH_TIMEOUT_MS,
  });
  return result.stdout;
}

async function resolveRepositorySkillCredential(
  repository: RepositorySkillRepository,
): Promise<RepositorySkillCredential> {
  switch (repository.sourceControlProvider) {
    case 'github': {
      if (!repository.installationId || repository.githubRepoId == null) {
        throw new Error('The GitHub repository is missing installation data.');
      }
      const credential = await createGitHubTokenWithMetadata(
        {
          type: 'installationId',
          installationId: repository.installationId,
          repositoryIds: [repository.githubRepoId],
        },
        undefined,
        { cache: true },
      );
      return { token: credential.token, username: 'x-access-token' };
    }
    case 'gitlab': {
      const token = await resolveGitLabToken();
      if (!token) throw new Error('GitLab authorization is unavailable.');
      return { token, username: 'oauth2' };
    }
    case 'gitea': {
      const token = await resolveGiteaToken();
      if (!token) throw new Error('Gitea authorization is unavailable.');
      return {
        token,
        username: (await resolveGiteaUsername()) ?? 'oauth2',
      };
    }
    case 'ado': {
      const token = await resolveAdoToken();
      if (!token) throw new Error('Azure DevOps authorization is unavailable.');
      return { authorizationHeader: buildAdoAuthorizationHeader(token) };
    }
    case 'bitbucket': {
      const credential = await resolveBitbucketAuth();
      return { token: credential.token, username: 'x-token-auth' };
    }
  }
}

async function buildGitAuthenticationEnvironment(
  directory: string,
  credential: RepositorySkillCredential,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
  if ('authorizationHeader' in credential) {
    return {
      ...env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: ${credential.authorizationHeader}`,
    };
  }

  const askPassPath = join(directory, 'askpass.sh');
  await writeFile(
    askPassPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  *Username*) printf "%s\\n" "$ROOMOTE_FAST_SKILL_GIT_USERNAME" ;;',
      '  *) printf "%s\\n" "$ROOMOTE_FAST_SKILL_GIT_TOKEN" ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(askPassPath, 0o700);
  return {
    ...env,
    GIT_ASKPASS: askPassPath,
    ROOMOTE_FAST_SKILL_GIT_TOKEN: credential.token,
    ROOMOTE_FAST_SKILL_GIT_USERNAME: credential.username,
  };
}

function parseGitTree(output: string): Array<{
  byteLength: number;
  mode: string;
  path: string;
  type: string;
}> {
  const entries: Array<{
    byteLength: number;
    mode: string;
    path: string;
    type: string;
  }> = [];
  for (const rawEntry of output.split('\0')) {
    if (!rawEntry) continue;
    const match = /^(\d{6})\s+(\w+)\s+[0-9a-f]+\s+(\d+|-)\t([\s\S]+)$/u.exec(
      rawEntry,
    );
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) continue;
    const byteLength = Number(match[3]);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) continue;
    entries.push({
      byteLength,
      mode: match[1],
      path: match[4],
      type: match[2],
    });
  }
  return entries;
}

export function parseFastAgentRepositorySkillTree(output: string): Array<{
  byteLength: number;
  mode: string;
  path: string;
  type: string;
}> {
  return parseGitTree(output)
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        (entry.mode === '100644' || entry.mode === '100755') &&
        entry.path.length <= REPOSITORY_SKILL_PATH_MAX_CHARS &&
        entry.path.endsWith('.md') &&
        entry.byteLength <= FAST_AGENT_SPILL_MAX_FILE_BYTES,
    )
    .sort((left, right) => {
      const leftMain = left.path.endsWith('/SKILL.md');
      const rightMain = right.path.endsWith('/SKILL.md');
      return leftMain === rightMain
        ? left.path.localeCompare(right.path)
        : leftMain
          ? -1
          : 1;
    })
    .slice(0, REPOSITORY_SKILL_MAX_FILES);
}

async function readGitResource({
  directory,
  env,
  path,
  revision,
}: {
  directory: string;
  env: NodeJS.ProcessEnv;
  path: string;
  revision: string;
}): Promise<string> {
  return runGit(['-C', directory, 'show', `${revision}:${path}`], { env });
}

async function loadFastAgentRepositorySkillSnapshot(
  repository: RepositorySkillRepository,
): Promise<RepositorySkillSnapshot> {
  const cloneUrl = stripCloneUrlUserInfo(repository.cloneUrl);
  const parsedCloneUrl = new URL(cloneUrl);
  if (!['http:', 'https:'].includes(parsedCloneUrl.protocol)) {
    throw new Error('Repository skill discovery requires an HTTP clone URL.');
  }

  const directory = await mkdtemp(join(tmpdir(), 'roomote-fast-skills-'));
  try {
    const credential = await resolveRepositorySkillCredential(repository);
    const env = await buildGitAuthenticationEnvironment(directory, credential);
    const repositoryDirectory = join(directory, 'repository.git');
    await runGit(['init', '--bare', repositoryDirectory], { env });
    await runGit(
      ['-C', repositoryDirectory, 'remote', 'add', 'origin', cloneUrl],
      { env },
    );
    await runGit(
      [
        '-C',
        repositoryDirectory,
        'fetch',
        '--depth=1',
        '--filter=blob:none',
        '--no-tags',
        'origin',
        `refs/heads/${repository.defaultBranch}`,
      ],
      { env },
    );
    const revision = (
      await runGit(['-C', repositoryDirectory, 'rev-parse', 'FETCH_HEAD'], {
        env,
      })
    ).trim();
    const tree = parseFastAgentRepositorySkillTree(
      await runGit(
        [
          '-C',
          repositoryDirectory,
          'ls-tree',
          '-r',
          '-z',
          '-l',
          revision,
          '--',
          '.agents/skills',
          '.claude/skills',
        ],
        { env },
      ),
    );

    const roots = new Map<
      string,
      { root: string; resources: Map<string, RepositorySkillResource> }
    >();
    for (const entry of tree) {
      const match = REPOSITORY_SKILL_ROOT_PATTERN.exec(entry.path);
      if (!match?.[1] || !match[2] || !match[3]) continue;
      const root = `${match[1]}/skills/${match[2]}`;
      const existing = roots.get(match[2]);
      if (existing && existing.root !== root) continue;
      const skill = existing ?? { root, resources: new Map() };
      skill.resources.set(match[3], {
        byteLength: entry.byteLength,
        path: entry.path,
        resource: match[3],
      });
      roots.set(match[2], skill);
    }

    const records: RepositorySkillRecord[] = [];
    for (const [name, skill] of [...roots].slice(
      0,
      REPOSITORY_SKILL_MAX_SKILLS,
    )) {
      const main = skill.resources.get('SKILL.md');
      if (!main) continue;
      const mainContent = await readGitResource({
        directory: repositoryDirectory,
        env,
        path: main.path,
        revision,
      });
      if (
        Buffer.byteLength(mainContent, 'utf8') > FAST_AGENT_SPILL_MAX_FILE_BYTES
      ) {
        continue;
      }
      records.push({
        description: getFastAgentSkillDescription(mainContent),
        environmentIds: repository.environmentIds,
        gitEnvironment: env,
        id: repositorySkillId(repository.id, skill.root, name),
        invocation: name,
        mainContent,
        name,
        repository: repository.fullName,
        repositoryDirectory,
        resources: skill.resources,
        revision,
      });
    }
    return { directory, records };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function resolveRepositorySkillRepositories(
  allowedEnvironmentIds: string[],
  environmentId?: string,
): Promise<RepositorySkillRepository[]> {
  const selectedEnvironmentIds = environmentId
    ? [environmentId]
    : allowedEnvironmentIds;
  if (selectedEnvironmentIds.length === 0) return [];
  const rows = await db
    .select({
      cloneUrl: repositories.cloneUrl,
      defaultBranch: repositories.defaultBranch,
      environmentId: environmentRepositoryMappings.environmentId,
      fullName: repositories.fullName,
      githubRepoId: repositories.githubRepoId,
      id: repositories.id,
      installationId: repositories.installationId,
      sourceControlProvider: repositories.sourceControlProvider,
    })
    .from(environmentRepositoryMappings)
    .innerJoin(
      repositories,
      eq(environmentRepositoryMappings.repositoryId, repositories.id),
    )
    .where(
      and(
        eq(repositories.isActive, true),
        inArray(
          environmentRepositoryMappings.environmentId,
          selectedEnvironmentIds,
        ),
      ),
    );

  const grouped = new Map<string, RepositorySkillRepository>();
  for (const row of rows) {
    const current = grouped.get(row.id);
    if (current) {
      current.environmentIds.push(row.environmentId);
      continue;
    }
    grouped.set(row.id, {
      cloneUrl: row.cloneUrl,
      defaultBranch: row.defaultBranch,
      environmentIds: [row.environmentId],
      fullName: row.fullName,
      githubRepoId: row.githubRepoId,
      id: row.id,
      installationId: row.installationId,
      sourceControlProvider: row.sourceControlProvider,
    });
  }
  return [...grouped.values()];
}

export class RemoteFastAgentRepositorySkillSource implements FastAgentRepositorySkillSource {
  private readonly allowedEnvironmentIds: Set<string>;
  private readonly loadSnapshot: (
    repository: RepositorySkillRepository,
  ) => Promise<RepositorySkillSnapshot>;
  private readonly records = new Map<string, RepositorySkillRecord>();
  private readonly resolveRepositories: (
    environmentId?: string,
  ) => Promise<RepositorySkillRepository[]>;
  private readonly snapshots = new Map<
    string,
    Promise<RepositorySkillSnapshot>
  >();

  constructor(options: FastAgentRepositorySkillSourceOptions) {
    this.allowedEnvironmentIds = new Set(options.allowedEnvironmentIds);
    this.loadSnapshot =
      options.loadSnapshot ?? loadFastAgentRepositorySkillSnapshot;
    this.resolveRepositories =
      options.resolveRepositories ??
      ((environmentId) =>
        resolveRepositorySkillRepositories(
          [...this.allowedEnvironmentIds],
          environmentId,
        ));
  }

  async list(environmentId?: string): Promise<FastAgentSkillListResult> {
    if (environmentId && !this.allowedEnvironmentIds.has(environmentId)) {
      throw new Error('Unknown Fast environment.');
    }
    const repositoriesList = (await this.resolveRepositories()).filter(
      (repository) =>
        !environmentId || repository.environmentIds.includes(environmentId),
    );
    const selectedRepositories = repositoriesList.slice(
      0,
      REPOSITORY_SKILL_MAX_REPOSITORIES,
    );
    const skills: FastAgentSkillSummary[] = [];
    const warnings: string[] = [];
    const omittedRepositoryCount =
      repositoriesList.length - selectedRepositories.length;
    if (omittedRepositoryCount > 0) {
      warnings.push(
        `Repository skill discovery omitted ${omittedRepositoryCount} repositories after reaching the limit of ${REPOSITORY_SKILL_MAX_REPOSITORIES}.`,
      );
    }
    for (
      let start = 0;
      start < selectedRepositories.length;
      start += REPOSITORY_SKILL_FETCH_CONCURRENCY
    ) {
      const results = await Promise.all(
        selectedRepositories
          .slice(start, start + REPOSITORY_SKILL_FETCH_CONCURRENCY)
          .map(async (repository) => {
            let snapshotPromise = this.snapshots.get(repository.id);
            if (!snapshotPromise) {
              snapshotPromise = this.loadSnapshot(repository);
              this.snapshots.set(repository.id, snapshotPromise);
            }
            try {
              return { repository, snapshot: await snapshotPromise };
            } catch {
              return { repository, snapshot: null };
            }
          }),
      );
      for (const { repository, snapshot } of results) {
        if (!snapshot) {
          warnings.push(
            `Repository skills could not be inspected for ${repository.fullName}.`,
          );
          continue;
        }
        for (const record of snapshot.records) {
          this.records.set(record.id, record);
          skills.push({
            description: record.description,
            environmentIds: record.environmentIds,
            id: record.id,
            invocation: record.invocation,
            name: record.name,
            repository: record.repository,
            source: 'repository',
          });
        }
      }
    }
    const repositoriesByName = new Map<string, Set<string>>();
    for (const skill of skills) {
      const owners = repositoriesByName.get(skill.name) ?? new Set<string>();
      owners.add(skill.repository ?? 'repository');
      repositoriesByName.set(skill.name, owners);
    }
    for (const skill of skills) {
      if ((repositoriesByName.get(skill.name)?.size ?? 0) <= 1) continue;
      skill.invocation = `${normalizeInvocationSegment(
        skill.repository ?? '',
        'repo',
      )}.${normalizeInvocationSegment(skill.name, 'skill')}`;
      const record = this.records.get(skill.id);
      if (record) record.invocation = skill.invocation;
    }
    return { skills, warnings };
  }

  async read(
    id: string,
    resource = 'SKILL.md',
  ): Promise<FastAgentSkillDocument> {
    const record = this.records.get(id);
    const selectedResource = record?.resources.get(resource);
    if (!record || !selectedResource)
      throw new Error('Unknown skill resource.');
    const content =
      resource === 'SKILL.md'
        ? record.mainContent
        : await readGitResource({
            directory: record.repositoryDirectory,
            env: record.gitEnvironment,
            path: selectedResource.path,
            revision: record.revision,
          });
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > FAST_AGENT_SPILL_MAX_FILE_BYTES) {
      throw new Error('Skill resource is too large.');
    }
    return {
      byteLength,
      content,
      description: resource === 'SKILL.md' ? record.description : '',
      environmentIds: record.environmentIds,
      id: record.id,
      invocation: record.invocation,
      name: record.name,
      repository: record.repository,
      resource,
      resources: [...record.resources.keys()].sort(),
      source: 'repository',
    };
  }

  async dispose(): Promise<void> {
    const settled = await Promise.allSettled(this.snapshots.values());
    await Promise.all(
      settled.flatMap((result) =>
        result.status === 'fulfilled'
          ? [rm(result.value.directory, { recursive: true, force: true })]
          : [],
      ),
    );
    this.records.clear();
    this.snapshots.clear();
  }
}
