import { buildDoctorEnvironmentContext } from './environment-context';

describe('buildDoctorEnvironmentContext', () => {
  it('passes environment variable names and classifications without values', () => {
    const secretValue = 'doctor-context-secret-value';
    const context = buildDoctorEnvironmentContext({
      workspacePath: '/workspace',
      environmentConfig: {
        name: 'Test',
        repositories: [{ repository: 'owner/repo' }],
        env: {
          API_KEY: secretValue,
          DATABASE_URL: 'postgresql://private',
        },
        services: ['postgres16'],
      },
      envVars: {
        API_KEY: secretValue,
        POSTGRES_HOST: 'localhost',
      },
    });
    const serialized = JSON.stringify(context);

    expect(context.configuredEnvVars).toEqual([
      { name: 'API_KEY', withheld: false },
      { name: 'DATABASE_URL', withheld: true },
    ]);
    expect(context.services[0]?.envVarNames).toContain('DATABASE_URL');
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain('postgresql://private');
  });

  it('preserves the resolved Compose invocation without project env values', () => {
    const context = buildDoctorEnvironmentContext({
      workspacePath: '/workspace',
      repoPaths: { 'owner/repo': '/workspace/custom-repo' },
      environmentConfig: {
        name: 'Test',
        repositories: [{ repository: 'owner/repo' }],
        ports: [{ name: 'WEB', port: 3000 }],
        docker_projects: [
          {
            name: 'app',
            repository: 'owner/repo',
            type: 'compose',
            working_dir: 'deploy',
            files: ['compose.roomote.yml'],
            profiles: ['web'],
            env: { DATABASE_PASSWORD: 'never-serialize-this' },
            ports: [
              { named_port: 'WEB', service: 'web', container_port: 3000 },
            ],
          },
        ],
      },
      envVars: {},
    });

    expect(context.dockerProjects).toEqual([
      {
        name: 'app',
        required: true,
        cwd: '/workspace/custom-repo/deploy',
        composeFiles: [
          '/workspace/custom-repo/deploy/compose.roomote.yml',
          '/workspace/.roomote/docker-projects/roomote-app.ports.yaml',
        ],
        profiles: ['web'],
      },
    ]);
    expect(JSON.stringify(context)).not.toContain('never-serialize-this');
  });
});
