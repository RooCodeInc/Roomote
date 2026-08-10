import * as path from 'node:path';

import {
  CONTROL_PLANE_ENV_VAR_NAMES,
  serviceDefaultPorts,
  toComposeProjectName,
  type EnvironmentConfig,
  type ServiceName,
} from '@roomote/types';
import { z } from 'zod';

export const doctorEnvironmentContextSchema = z.object({
  ports: z.array(
    z.object({
      name: z.string(),
      port: z.number(),
      initialPath: z.string().optional(),
      previewUrl: z.string().optional(),
    }),
  ),
  services: z.array(
    z.object({
      name: z.string(),
      port: z.number(),
      envVarNames: z.array(z.string()),
    }),
  ),
  dockerProjects: z.array(
    z.object({
      name: z.string(),
      required: z.boolean(),
      cwd: z.string(),
      composeFiles: z.array(z.string()),
      profiles: z.array(z.string()),
    }),
  ),
  toolVersions: z.array(
    z.object({
      tool: z.string(),
      declaredVersion: z.string(),
      cwd: z.string(),
      scope: z.string(),
    }),
  ),
  configuredEnvVars: z.array(
    z.object({ name: z.string(), withheld: z.boolean() }),
  ),
  presentEnvVarNames: z.array(z.string()),
});

export type DoctorEnvironmentContext = z.infer<
  typeof doctorEnvironmentContextSchema
>;

const SERVICE_ENV_VAR_NAMES: Record<ServiceName, string[]> = {
  redis6: ['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT'],
  redis7: ['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT'],
  postgres15: [
    'DATABASE_URL',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_USER',
    'POSTGRES_DB',
  ],
  postgres16: [
    'DATABASE_URL',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_USER',
    'POSTGRES_DB',
  ],
  postgres17: [
    'DATABASE_URL',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_USER',
    'POSTGRES_DB',
  ],
  mysql8: [
    'MYSQL_URL',
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_USER',
    'MYSQL_SOCKET',
  ],
  mariadb10: [
    'MYSQL_URL',
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_USER',
    'MYSQL_SOCKET',
  ],
  clickhouse: [
    'CLICKHOUSE_URL',
    'CLICKHOUSE_HOST',
    'CLICKHOUSE_PORT',
    'CLICKHOUSE_TCP_PORT',
    'CLICKHOUSE_DATABASE',
  ],
  codeserver: [],
  aws: [],
};

export function buildDoctorEnvironmentContext(options: {
  environmentConfig?: EnvironmentConfig;
  workspacePath: string;
  repoPaths?: Record<string, string>;
  envVars: Record<string, string | undefined>;
}): DoctorEnvironmentContext {
  const config = options.environmentConfig;
  if (!config) {
    return {
      ports: [],
      services: [],
      dockerProjects: [],
      toolVersions: [],
      configuredEnvVars: [],
      presentEnvVarNames: Object.keys(options.envVars).sort(),
    };
  }

  const toolVersions: DoctorEnvironmentContext['toolVersions'] = Object.entries(
    config.tool_versions ?? {},
  ).map(([tool, declaredVersion]) => ({
    tool,
    declaredVersion,
    cwd: options.workspacePath,
    scope: 'workspace',
  }));

  for (const repository of config.repositories) {
    const cwd =
      options.repoPaths?.[repository.repository] ??
      path.join(options.workspacePath, repository.repository);
    for (const [tool, declaredVersion] of Object.entries(
      repository.tool_versions ?? {},
    )) {
      toolVersions.push({
        tool,
        declaredVersion,
        cwd,
        scope: repository.repository,
      });
    }
  }

  return {
    ports: (config.ports ?? []).map((port) => {
      const name = port.name.toUpperCase();
      const previewUrl = options.envVars[`ROOMOTE_${name}_PREVIEW_URL`];
      return {
        name,
        port: port.port,
        ...(port.initial_path ? { initialPath: port.initial_path } : {}),
        ...(previewUrl ? { previewUrl } : {}),
      };
    }),
    services: (config.services ?? []).map((service) => {
      const name = typeof service === 'string' ? service : service.name;
      return {
        name,
        port:
          typeof service === 'string'
            ? serviceDefaultPorts[name]
            : (service.port ?? serviceDefaultPorts[name]),
        envVarNames: SERVICE_ENV_VAR_NAMES[name],
      };
    }),
    dockerProjects: (config.docker_projects ?? []).map((project) => {
      const repositoryRoot =
        options.repoPaths?.[project.repository] ??
        path.join(options.workspacePath, project.repository);
      const cwd = path.join(repositoryRoot, project.working_dir ?? '.');
      const generatedComposeDirectory = path.join(
        options.workspacePath,
        '.roomote',
        'docker-projects',
      );
      const projectName = toComposeProjectName(project.name);
      const composeFiles =
        project.type === 'compose'
          ? [
              ...project.files.map((file) => path.join(cwd, file)),
              ...(project.ports?.length
                ? [
                    path.join(
                      generatedComposeDirectory,
                      `${projectName}.ports.yaml`,
                    ),
                  ]
                : []),
            ]
          : [
              path.join(
                generatedComposeDirectory,
                `${projectName}.dockerfile.yaml`,
              ),
            ];

      return {
        name: project.name,
        required: project.required !== false,
        cwd,
        composeFiles,
        profiles: project.type === 'compose' ? (project.profiles ?? []) : [],
      };
    }),
    toolVersions,
    configuredEnvVars: Object.keys(config.env ?? {})
      .sort()
      .map((name) => ({
        name,
        withheld: CONTROL_PLANE_ENV_VAR_NAMES.has(name),
      })),
    presentEnvVarNames: Object.entries(options.envVars)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([name]) => name)
      .sort(),
  };
}
