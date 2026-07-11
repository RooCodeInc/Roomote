import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import YAML from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const catalog = JSON.parse(read('deploy/deployment-catalog.json'));

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function commandText(command) {
  if (Array.isArray(command)) return command.join(' ');
  return String(command ?? '');
}

const composeEnv = {
  ...process.env,
  APP_ENV: 'production',
  ARTIFACT_SIGNING_KEY: 'deployment-ci-artifact-signing-key',
  CADDY_HTTP_PORT: '18080',
  CADDY_HTTPS_PORT: '18443',
  COMPOSE_PROFILES: 'local-postgres',
  DASHBOARD_PASSWORD: 'deployment-ci-dashboard-password',
  DATABASE_URL: 'postgres://postgres:password@postgres:5432/roomote',
  DEFAULT_COMPUTE_PROVIDER: 'docker',
  DOCKER_WORKER_IMAGE: 'roomote-worker:deployment-ci',
  ENCRYPTION_KEY: 'deployment-ci-encryption-key',
  IMAGE_NAMESPACE: 'roomote',
  IMAGE_REGISTRY: 'localhost',
  JOB_AUTH_PRIVATE_KEY: 'deployment-ci-job-private-key',
  JOB_AUTH_PUBLIC_KEY: 'deployment-ci-job-public-key',
  NEXT_PUBLIC_GITHUB_APP_SLUG: 'deployment-ci',
  PREVIEW_AUTH_PRIVATE_KEY: 'deployment-ci-preview-private-key',
  PREVIEW_AUTH_PUBLIC_KEY: 'deployment-ci-preview-public-key',
  REDIS_URL: 'redis://redis:6379',
  ROOMOTE_APP_DOMAIN: 'roomote.localhost',
  ROOMOTE_PREVIEW_DOMAIN: 'preview.roomote.localhost',
  ROOMOTE_VERSION: 'deployment-ci',
  S3_ACCESS_KEY_ID: 'roomote',
  S3_SECRET_ACCESS_KEY: 'deployment-ci-minio-password',
};

function validateComposeShape(shape) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'roomote-compose-'));
  let files = shape.files.map((file) => join(root, file));

  try {
    if (shape.coolify) {
      const normalized = read(shape.files[0]).replace(
        /^([ \t]*)exclude_from_hc:/gm,
        '$1x-exclude_from_hc:',
      );
      const normalizedPath = join(temporaryDirectory, 'docker-compose.yaml');
      writeFileSync(normalizedPath, normalized);
      files = [normalizedPath];
    } else if (
      shape.files.length === 1 &&
      read(shape.files[0]).includes('    - .env')
    ) {
      const serviceEnvPath = join(temporaryDirectory, 'service.env');
      writeFileSync(
        serviceEnvPath,
        Object.entries(composeEnv)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      );
      const normalized = read(shape.files[0]).replace(
        '    - .env',
        `    - ${serviceEnvPath}`,
      );
      const normalizedPath = join(temporaryDirectory, 'docker-compose.yml');
      writeFileSync(normalizedPath, normalized);
      files = [normalizedPath];
    }

    const args = ['compose', '--profile', '*'];
    for (const file of files) args.push('-f', file);
    args.push('config', '--format', 'json');

    const output = execFileSync('docker', args, {
      cwd: root,
      env: composeEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const config = JSON.parse(output);

    assert(
      config.services && Object.keys(config.services).length > 0,
      `${shape.name}: docker compose config produced no services`,
    );

    if (shape.requiresExecutionHealth) {
      for (const serviceName of ['controller', 'bullmq']) {
        const service = config.services[serviceName];
        assert(service, `${shape.name}: missing ${serviceName} service`);
        assert(
          service.healthcheck?.test?.length,
          `${shape.name}: ${serviceName} must have a production healthcheck`,
        );
      }
    }

    console.log(`validated compose shape: ${shape.name}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

for (const shape of catalog.composeShapes) validateComposeShape(shape);

const railway = YAML.parse(read('deploy/railway/template.yaml'));
for (const [name, contract] of Object.entries(catalog.runtimeServices)) {
  const service = railway.services?.[name];
  assert(service, `railway: missing ${name}`);
  assert(
    commandText(service.start_command).endsWith(` ${contract.command}`),
    `railway: ${name} does not use the ${contract.command} app command`,
  );
  if (service.healthcheck_path) {
    assert(
      service.healthcheck_path === contract.healthPath,
      `railway: ${name} health path drifted from the catalog`,
    );
  }
}
for (const key of catalog.sharedPlatformEnvironment) {
  assert(
    key in railway.services.api.env,
    `railway: api is missing shared ${key}`,
  );
}

const render = YAML.parse(read('render.yaml'));
const renderServices = new Map(
  render.services.map((service) => [
    service.name.replace(/^roomote-/, ''),
    service,
  ]),
);
for (const [name, contract] of Object.entries(catalog.runtimeServices)) {
  if (name === 'controller' || name === 'bullmq') {
    assert(renderServices.has(name), `render: missing ${name}`);
  } else {
    assert(
      renderServices.get(name)?.healthCheckPath === contract.healthPath,
      `render: ${name} health path drifted from the catalog`,
    );
  }
  assert(
    commandText(renderServices.get(name)?.dockerCommand).endsWith(
      ` ${contract.command}`,
    ),
    `render: ${name} does not use the ${contract.command} app command`,
  );
}
assert(
  renderServices.get('api')?.preDeployCommand?.endsWith(' db-migrate'),
  'render: api must run migrations before deploy',
);

const coolify = YAML.parse(read('deploy/coolify/docker-compose.yaml'));
for (const [name, contract] of Object.entries(catalog.runtimeServices)) {
  const service = coolify.services?.[name];
  assert(service, `coolify: missing ${name}`);
  assert(
    commandText(service.command) === contract.command,
    `coolify: ${name} command drifted from the catalog`,
  );
  if (name !== 'controller' && name !== 'bullmq') {
    assert(
      commandText(service.healthcheck?.test).includes(contract.healthPath),
      `coolify: ${name} health path drifted from the catalog`,
    );
  }
}

const fly = parseToml(read('deploy/fly/fly.toml'));
for (const [name, contract] of Object.entries(catalog.runtimeServices)) {
  assert(
    fly.processes?.[name] === contract.command,
    `fly: ${name} command drifted from the catalog`,
  );
}
assert(
  fly.deploy?.release_command === 'db-migrate',
  'fly: missing migration release command',
);

const imageLocations = {
  // List only files that directly declare or run each image. The remote
  // backup/restore scripts delegate datastore operations to deploy/host/roomote.
  postgres: [
    'docker-compose.yml',
    'deploy/compose/docker-compose.prod.yml',
    'deploy/coolify/docker-compose.yaml',
    'deploy/host/roomote',
  ],
  redis: [
    'docker-compose.yml',
    'deploy/compose/docker-compose.prod.yml',
    'deploy/coolify/docker-compose.yaml',
  ],
  minio: [
    'docker-compose.yml',
    'deploy/compose/docker-compose.prod.yml',
    'deploy/coolify/docker-compose.yaml',
    'deploy/railway/template.yaml',
    'render.yaml',
  ],
  minioClient: ['docker-compose.yml', 'deploy/compose/docker-compose.prod.yml'],
  caddy: [
    'docker-compose.yml',
    'docker-compose.production.yml',
    'deploy/compose/docker-compose.prod.yml',
  ],
};

for (const [imageName, locations] of Object.entries(imageLocations)) {
  const pinnedImage = catalog.criticalImages[imageName];
  for (const location of locations) {
    assert(
      read(location).includes(pinnedImage),
      `${location}: ${imageName} must match deployment-catalog.json`,
    );
  }
}

for (const script of [
  'deploy/install.sh',
  'deploy/host/roomote',
  'deploy/scripts/backup.sh',
  'deploy/scripts/deploy.sh',
  'deploy/scripts/destroy.sh',
  'deploy/scripts/lib.sh',
  'deploy/scripts/prune-release-images.sh',
  'deploy/scripts/restore.sh',
  'deploy/scripts/roomote-deploy',
  'deploy/scripts/upgrade.sh',
  'deploy/ci/deployment-smoke.sh',
  'deploy/ci/upgrade-compatibility.sh',
  'deploy/host/tests/backup-restore.integration.sh',
]) {
  execFileSync('bash', ['-n', join(root, script)], { stdio: 'pipe' });
}

for (const directory of ['.github/workflows', '.github/actions']) {
  for (const entry of readdirSync(join(root, directory), { recursive: true })) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const path = join(directory, entry);
    for (const match of read(path).matchAll(
      /^\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm,
    )) {
      const target = match[1];
      if (target.startsWith('./')) continue;
      assert(
        /@[0-9a-f]{40}$/.test(target),
        `${path}: external action is not pinned to a commit SHA: ${target}`,
      );
    }
  }
}

console.log('deployment artifacts match the shared catalog');
