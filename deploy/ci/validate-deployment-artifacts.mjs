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
const installer = read('deploy/install.sh');
const deployer = read('deploy/scripts/deploy.sh');
const upgradeCompatibility = read('deploy/ci/upgrade-compatibility.sh');
const productionEnvExample = read('.env.production.example');

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

assert(
  installer.includes('--no-setup-url') &&
    installer.includes("print_setup_url='false'") &&
    installer.includes('sudo roomote setup-url'),
  'installer: automated installs must be able to suppress the tokenized setup URL',
);

assert(
  installer.includes('preview_domain="$domain"') &&
    installer.includes(
      'preview_subdomain_suffix="${saved_preview_subdomain_suffix:-preview}"',
    ),
  'installer: new installs must default to flat preview hostnames with a suffix',
);
assert(
  installer.includes(
    'read_saved_env_value "$install_root/.env" ROOMOTE_PREVIEW_DOMAIN',
  ) &&
    installer.includes(
      'read_saved_env_value "$install_root/.env" PREVIEW_PROXY_SUBDOMAIN_SUFFIX',
    ),
  'installer: reruns must preserve existing preview hostname settings',
);
assert(
  installer.includes(
    'set_env_value PREVIEW_PROXY_SUBDOMAIN_SUFFIX "$preview_subdomain_suffix"',
  ),
  'installer: preview suffix must be persisted for Compose services',
);
assert(
  productionEnvExample.includes(
    'ROOMOTE_APP_DOMAIN=roomote.example.com\nROOMOTE_PREVIEW_DOMAIN=roomote.example.com\nPREVIEW_PROXY_SUBDOMAIN_SUFFIX=preview',
  ),
  'production env example: new installs must default to flat preview hostnames',
);
assert(
  deployer.includes('preview_domain="$domain"') &&
    deployer.includes(
      'configured_preview_subdomain_suffix="$(read_env_value "$env_file" PREVIEW_PROXY_SUBDOMAIN_SUFFIX)"',
    ) &&
    deployer.includes(
      'preview_subdomain_suffix="$configured_preview_subdomain_suffix"',
    ) &&
    deployer.includes(
      'set_env_value "$tmp_env" PREVIEW_PROXY_SUBDOMAIN_SUFFIX "$preview_subdomain_suffix"',
    ),
  'DigitalOcean deployer: flat previews must preserve custom suffixes and default to preview',
);
assert(
  deployer.includes('read_tfvars_value "$tfvars_file" domain') &&
    deployer.includes('read_tfvars_value "$tfvars_file" preview_domain'),
  'DigitalOcean deployer: reruns must preserve the preview layout, not a stale preview domain',
);
const digitalOceanTerraform = read('deploy/providers/digitalocean/main.tf');
assert(
  digitalOceanTerraform.includes(
    'preview_domain = var.preview_domain != "" ? var.preview_domain : var.domain',
  ) &&
    digitalOceanTerraform.includes(
      'count  = var.manage_dns && local.preview_domain != var.domain ? 1 : 0',
    ),
  'DigitalOcean Terraform: flat previews must not duplicate the app DNS record',
);
assert(
  digitalOceanTerraform.includes('local.preview_domain == var.dns_zone') &&
    digitalOceanTerraform.includes('var.domain == var.dns_zone'),
  'DigitalOcean Terraform: zone-apex domains must map to "@"/"*" record names',
);
assert(
  upgradeCompatibility.includes('COMPOSE_PROFILES=local-postgres,brain') &&
    upgradeCompatibility.includes('bullmq gbrain preview-proxy'),
  'upgrade compatibility: the Brain profile must boot gbrain explicitly',
);

function commandText(command) {
  if (Array.isArray(command)) return command.join(' ');
  return String(command ?? '');
}

function normalizedEnvironment(environment) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(environment ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

const composeEnv = {
  ...process.env,
  R_APP_ENV: 'production',
  ARTIFACT_SIGNING_KEY: 'deployment-ci-artifact-signing-key',
  CADDY_HTTP_PORT: '18080',
  CADDY_HTTPS_PORT: '18443',
  COMPOSE_PROFILES: 'local-postgres',
  DASHBOARD_PASSWORD: 'deployment-ci-dashboard-password',
  DATABASE_URL: 'postgres://postgres:password@postgres:5432/roomote',
  DEFAULT_COMPUTE_PROVIDER: 'docker',
  DOCKER_WORKER_IMAGE: 'roomote-worker:deployment-ci',
  ENCRYPTION_KEY: 'deployment-ci-encryption-key',
  GBRAIN_IMAGE: '',
  IMAGE_NAMESPACE: 'roomote',
  IMAGE_REGISTRY: 'localhost',
  JOB_AUTH_PRIVATE_KEY: 'deployment-ci-job-private-key',
  JOB_AUTH_PUBLIC_KEY: 'deployment-ci-job-public-key',
  R_GITHUB_APP_SLUG: 'deployment-ci',
  R_DISCORD_BOT_TOKEN: 'deployment-ci-discord-bot-token',
  R_DISCORD_GATEWAY_SECRET: 'deployment-ci-discord-gateway-secret',
  PREVIEW_AUTH_PRIVATE_KEY: 'deployment-ci-preview-private-key',
  PREVIEW_AUTH_PUBLIC_KEY: 'deployment-ci-preview-public-key',
  PREVIEW_PROXY_SUBDOMAIN_SUFFIX: 'preview',
  REDIS_URL: 'redis://redis:6379',
  ROOMOTE_APP_DOMAIN: 'roomote.localhost',
  ROOMOTE_CADDY_LOCAL_CERTS: 'local_certs',
  ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET: '',
  R_APP_URL: 'http://roomote.localhost',
  ROOMOTE_PREVIEW_DOMAIN: 'roomote.localhost',
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

    if (config.services.bullmq) {
      assert(
        config.services.bullmq.environment?.R_DISCORD_BOT_TOKEN ===
          composeEnv.R_DISCORD_BOT_TOKEN,
        `${shape.name}: bullmq must receive R_DISCORD_BOT_TOKEN`,
      );
      // Coolify uses platform magic vars that compose does not interpolate here.
      if (
        !shape.coolify &&
        'R_DISCORD_GATEWAY_SECRET' in (config.services.bullmq.environment ?? {})
      ) {
        assert(
          config.services.bullmq.environment?.R_DISCORD_GATEWAY_SECRET ===
            composeEnv.R_DISCORD_GATEWAY_SECRET,
          `${shape.name}: bullmq must receive R_DISCORD_GATEWAY_SECRET`,
        );
      }
    }

    if (['self-host-production', 'installer-production'].includes(shape.name)) {
      for (const serviceName of ['web', 'api', 'controller', 'preview-proxy']) {
        const service = config.services[serviceName];
        if (!service) continue;
        assert(
          service.environment?.PREVIEW_PROXY_SUBDOMAIN_SUFFIX ===
            composeEnv.PREVIEW_PROXY_SUBDOMAIN_SUFFIX,
          `${shape.name}: ${serviceName} must receive PREVIEW_PROXY_SUBDOMAIN_SUFFIX`,
        );
      }
    }

    if (shape.name === 'installer-production') {
      const expectedGbrainImage = `${composeEnv.IMAGE_REGISTRY}/${composeEnv.IMAGE_NAMESPACE}/roomote-gbrain:${composeEnv.ROOMOTE_VERSION}`;
      assert(
        config.services.gbrain?.image === expectedGbrainImage,
        `installer-production: gbrain must default to matching release image ${expectedGbrainImage}`,
      );

      const overrideImage = 'registry.example/roomote/gbrain:operator-pinned';
      const overrideConfig = JSON.parse(
        execFileSync('docker', args, {
          cwd: root,
          env: { ...composeEnv, GBRAIN_IMAGE: overrideImage },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      assert(
        overrideConfig.services.gbrain?.image === overrideImage,
        'installer-production: explicit GBRAIN_IMAGE must override the matching release default',
      );
      assert(
        config.services.gbrain?.healthcheck?.test?.length,
        'installer-production: gbrain must have a healthcheck for upgrade validation',
      );
    }

    if (
      'ROOMOTE_CADDY_LOCAL_CERTS' in (config.services.caddy?.environment ?? {})
    ) {
      assert(
        config.services.caddy.environment?.ROOMOTE_CADDY_LOCAL_CERTS ===
          composeEnv.ROOMOTE_CADDY_LOCAL_CERTS,
        `${shape.name}: caddy must receive ROOMOTE_CADDY_LOCAL_CERTS`,
      );
      assert(
        config.services.caddy.environment
          ?.ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET ===
          composeEnv.ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET,
        `${shape.name}: caddy must receive ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET`,
      );
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
assert(
  'R_DISCORD_BOT_TOKEN' in railway.services.bullmq.env,
  'railway: bullmq must receive R_DISCORD_BOT_TOKEN',
);
assert(
  'R_DISCORD_GATEWAY_SECRET' in railway.services.api.env,
  'railway: api must define R_DISCORD_GATEWAY_SECRET',
);
assert(
  'R_DISCORD_GATEWAY_SECRET' in railway.services.bullmq.env,
  'railway: bullmq must receive R_DISCORD_GATEWAY_SECRET',
);
assert(
  railway.services.gbrain?.volume === '/data' &&
    JSON.stringify(railway.services.gbrain?.backup_schedules) ===
      JSON.stringify(['DAILY', 'WEEKLY']),
  'railway: gbrain must retain daily and weekly volume backups',
);

const gbrainEntrypoint = read('.docker/gbrain/entrypoint.sh');
assert(
  gbrainEntrypoint.includes(
    'gbrain config set agent.use_gateway_loop true >/dev/null',
  ),
  'gbrain: Roomote gateway models require the gateway-native agent loop',
);
const gbrainResetIndex = gbrainEntrypoint.indexOf(
  'write_storage_layout "$STORAGE_LAYOUT_RESETTING"',
);
const gbrainCutoverCompleteIndex = gbrainEntrypoint.indexOf(
  'write_storage_layout "$STORAGE_LAYOUT_VERSION"',
);
const gbrainInitIndex = gbrainEntrypoint.indexOf('\n    gbrain init');
assert(
  gbrainResetIndex >= 0 &&
    gbrainCutoverCompleteIndex > gbrainResetIndex &&
    gbrainCutoverCompleteIndex < gbrainInitIndex,
  'gbrain: filesystem cutover must be recorded before fallible initialization',
);

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
const renderSharedEnvironment = render.envVarGroups.find(
  (group) => group.name === 'roomote-shared',
);
assert(
  renderSharedEnvironment?.envVars?.some(
    (entry) => entry.key === 'R_DISCORD_BOT_TOKEN',
  ),
  'render: shared app environment must include R_DISCORD_BOT_TOKEN',
);
assert(
  renderSharedEnvironment?.envVars?.some(
    (entry) => entry.key === 'R_DISCORD_GATEWAY_SECRET',
  ),
  'render: shared app environment must include R_DISCORD_GATEWAY_SECRET',
);

const productionCompose = YAML.parse(
  read('deploy/compose/docker-compose.prod.yml'),
);
for (const serviceName of ['web', 'api', 'controller', 'preview-proxy']) {
  assert(
    productionCompose[`x-roomote-${serviceName}-env`]
      ?.PREVIEW_PROXY_SUBDOMAIN_SUFFIX !== undefined,
    `production compose: ${serviceName} must receive PREVIEW_PROXY_SUBDOMAIN_SUFFIX`,
  );
}
assert(
  read('deploy/caddy/Caddyfile').includes('{$ROOMOTE_CADDY_LOCAL_CERTS:}'),
  'caddy: Caddyfile must support the installer-managed local certificate mode',
);
assert(
  read('deploy/caddy/Caddyfile').includes(
    'on_demand_tls {\n\t\task http://web:3000/api/caddy/ask\n\t}',
  ),
  'caddy: Caddyfile must configure the on-demand TLS authorization endpoint directly',
);
assert(
  read('deploy/caddy/Caddyfile').includes(
    '{$ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET:import roomote_on_demand_wildcard_tls}',
  ),
  'caddy: Caddyfile must allow internal mode to remove wildcard on-demand TLS',
);
const caddyfile = read('deploy/caddy/Caddyfile');
assert(
  caddyfile.includes('path /api/webhooks /api/webhooks/*'),
  'caddy: app domain must route public webhooks directly to the API',
);
assert(
  caddyfile.includes(
    'handle @api_webhooks {\n\t\timport roomote_proxy api:3001',
  ),
  'caddy: public webhooks must bypass the web application',
);
assert(
  caddyfile.includes(
    'path_regexp local_sandbox ^/_roomote-sandbox/([a-z0-9]+)(/.*)$',
  ),
  'caddy: app domain must route same-origin sandbox-server requests',
);
assert(
  caddyfile.includes(
    'header_up Host {re.local_sandbox.1}-sandbox-server.{$ROOMOTE_PREVIEW_DOMAIN}',
  ),
  'caddy: same-origin sandbox route must target the sandbox-server preview host',
);
const renderCaddyTlsMode = (values) =>
  caddyfile
    .replace('{$ROOMOTE_CADDY_LOCAL_CERTS:}', values.localCertificates)
    .replace(
      '{$ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET:import roomote_on_demand_wildcard_tls}',
      values.wildcardTlsSnippet,
    );
const acmeCaddyfile = renderCaddyTlsMode({
  localCertificates: '',
  wildcardTlsSnippet: 'import roomote_on_demand_wildcard_tls',
});
const internalCaddyfile = renderCaddyTlsMode({
  localCertificates: 'local_certs',
  wildcardTlsSnippet: '',
});
function validateCaddyfile(mode, contents, environment) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'roomote-caddy-'));
  const configPath = join(temporaryDirectory, 'Caddyfile');

  try {
    writeFileSync(configPath, contents);
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--volume',
        `${configPath}:/etc/caddy/Caddyfile:ro`,
        ...Object.entries(environment).flatMap(([key, value]) => [
          '--env',
          `${key}=${value}`,
        ]),
        productionCompose.services.caddy.image,
        'caddy',
        'adapt',
        '--config',
        '/etc/caddy/Caddyfile',
        '--adapter',
        'caddyfile',
      ],
      { stdio: 'pipe' },
    );
    console.log(`validated Caddyfile: ${mode}`);
  } catch (error) {
    fail(`caddy: ${mode} configuration cannot be adapted: ${error.stderr}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const caddyEnvironment = {
  ROOMOTE_APP_DOMAIN: 'roomote.example.test',
  ROOMOTE_PREVIEW_DOMAIN: 'roomote.example.test',
  S3_BUCKET_ARTIFACTS: 'roomote-artifacts',
};
validateCaddyfile('acme', acmeCaddyfile, {
  ...caddyEnvironment,
  ROOMOTE_CADDY_LOCAL_CERTS: '',
  ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET: 'import roomote_on_demand_wildcard_tls',
});
validateCaddyfile('internal', internalCaddyfile, {
  ...caddyEnvironment,
  ROOMOTE_CADDY_LOCAL_CERTS: 'local_certs',
  ROOMOTE_CADDY_WILDCARD_TLS_SNIPPET: '',
});
const caddyGlobalBlock = (contents) =>
  contents.slice(0, contents.indexOf('}\n'));
const caddyWildcardSite = (contents) =>
  contents.slice(contents.indexOf('*.{$ROOMOTE_PREVIEW_DOMAIN} {'));
assert(
  caddyGlobalBlock(acmeCaddyfile).includes('on_demand_tls') &&
    caddyWildcardSite(acmeCaddyfile).includes(
      'import roomote_on_demand_wildcard_tls',
    ),
  'caddy: acme mode must import global and wildcard on-demand TLS',
);
assert(
  caddyGlobalBlock(internalCaddyfile).includes('local_certs') &&
    !caddyWildcardSite(internalCaddyfile).includes(
      'import roomote_on_demand_wildcard_tls',
    ),
  'caddy: internal mode must use local certificates without on-demand wildcard TLS',
);
const coolify = YAML.parse(read('deploy/coolify/docker-compose.yaml'));
assert(
  read('deploy/coolify/docker-compose.yaml').includes(
    'R_DISCORD_GATEWAY_SECRET',
  ),
  'coolify: shared env must define R_DISCORD_GATEWAY_SECRET',
);
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
assert(
  coolify.services?.['docker-proxy']?.environment?.VOLUMES === '1',
  'coolify: Docker proxy must allow managed workspace volume operations',
);
assert(
  normalizedEnvironment(coolify.services?.['docker-proxy']?.environment) ===
    normalizedEnvironment(
      productionCompose.services?.['docker-proxy']?.environment,
    ),
  'coolify: Docker proxy environment must match production Compose',
);
const coolifyBullmq = coolify.services?.bullmq;
assert(
  coolifyBullmq?.networks?.includes('default'),
  'coolify: bullmq must remain on the default application network',
);
assert(
  coolifyBullmq?.networks?.includes('docker-api'),
  'coolify: bullmq must join the docker-api network',
);
assert(
  coolifyBullmq?.depends_on?.['docker-proxy']?.condition === 'service_started',
  'coolify: bullmq must wait for the Docker proxy to start',
);
assert(
  coolifyBullmq?.environment?.DOCKER_HOST === 'tcp://docker-proxy:2375',
  'coolify: bullmq must use the restricted Docker proxy',
);
assert(
  coolifyBullmq?.environment?.DOCKER_WORKER_RELEASE_PATH ===
    '/roomote/releases/worker-current.tar.gz',
  'coolify: bullmq must receive the baked worker release path',
);

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
  'deploy/host/tests/upgrade-failed-pull.sh',
  '.docker/gbrain/entrypoint.sh',
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
