import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  db,
  eq,
  userFactory,
  sessionFactory,
  runFactory,
  sessionTasks,
  sessionEgressWorkloads,
  sessions,
  tasks,
  users,
} from '@roomote/db/server';
import {
  RunStatus,
  buildSessionEgressServiceTokenEnv,
  type RunTokenContext,
  type SessionProxyServices,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';
import { startOpenCodeCommandFixture } from './opencode-command-fixture';
import {
  prepareSessionSecret,
  createSessionSecret,
} from '@roomote/sdk/server/session-secrets';
import {
  registerProxyWorkload,
  syncProxyServicesForWorker,
  acknowledgeProxyServicesForWorker,
  authorizeProxy,
} from '@roomote/sdk/server/session-egress';

interface RuntimeWorker {
  acceptSessionEgressDelivery(env: Record<string, string>): void;
  setSessionProxyEnvFile(path: string): void;
  buildSessionEgressClientEnv(): Record<string, string>;
}
// Exercise the actual worker sources without making the API compilation own
// the worker source tree. The worker's own project typechecks those modules.
const { WorkerEnv } = (await import(
  new URL('../../../../../worker/src/env/worker-env.ts', import.meta.url).href
)) as { WorkerEnv: { fromProcessEnv(env: NodeJS.ProcessEnv): RuntimeWorker } };
const { syncSessionProxyOnce } = (await import(
  new URL(
    '../../../../../worker/src/env/session-proxy-sync.ts',
    import.meta.url,
  ).href
)) as {
  syncSessionProxyOnce(
    worker: RuntimeWorker,
    file: string,
    signal: AbortSignal,
  ): Promise<void>;
};
const { writeSessionProxyEnvFile } = (await import(
  new URL(
    '../../../../../worker/src/env/session-proxy-file.ts',
    import.meta.url,
  ).href
)) as {
  writeSessionProxyEnvFile(file: string, env: Record<string, string>): void;
};
const { buildHarnessCommandEnv } = (await import(
  new URL(
    '../../../../../worker/src/run-task/harnesses/harness-command-env.ts',
    import.meta.url,
  ).href
)) as {
  buildHarnessCommandEnv(env: Record<string, string>): Record<string, string>;
};
const { generateOpenCodeConfig } = (await import(
  new URL('../../../../../worker/src/run-task/agent-home.ts', import.meta.url)
    .href
)) as {
  generateOpenCodeConfig(input: {
    homeDir: string;
    runtimeEnv: Record<string, string>;
  }): { configContent: string; openCodeConfigDir: string };
};
const barrier = (await import(
  new URL(
    '../../../../../worker/src/lib/credential-write-barrier.ts',
    import.meta.url,
  ).href
)) as {
  engageCredentialWriteBarrier(): Promise<void>;
  releaseCredentialWriteBarrier(): void;
};

vi.mock('../../../../../worker/src/env/session-proxy', () => ({
  verifySessionProxyConnection: vi.fn().mockResolvedValue(undefined),
}));

const realKey = 'upstream-key-not-delivered-to-worker';
const originalMcp = sdk.mcpConnections;
let auth: RunTokenContext;
let sessionId: string;
let taskId: string;
let home: string;
let file: string;
let worker: RuntimeWorker;
let registration: Awaited<ReturnType<typeof registerProxyWorkload>>;
let last: SessionProxyServices;
let dropResponse = false;
let dropAck = false;
let hooks: {
  'tool.execute.before': (
    input: { tool: string },
    output: { args: { command: string } },
  ) => Promise<void>;
};
let modelEnv: NodeJS.ProcessEnv;

async function approve(label: string) {
  const context = { userId: auth.userId!, sessionId };
  const pending = await prepareSessionSecret(context, {
    label,
    origin: `https://${label.toLowerCase()}.example.com`,
    headerName: 'authorization',
    headerPrefix: 'Bearer ',
    allowedMethods: ['GET', 'POST'],
  });
  return createSessionSecret(context, {
    pendingRef: pending.pendingRef,
    secret: realKey,
    allowedMethods: pending.allowedMethods,
  });
}
async function allowNextPoll() {
  await db
    .update(sessionEgressWorkloads)
    .set({ proxyLastSyncAt: new Date(0) })
    .where(eq(sessionEgressWorkloads.id, registration.workloadId));
}
async function sync() {
  await allowNextPoll();
  await syncSessionProxyOnce(worker, file, new AbortController().signal);
}
async function command() {
  const args = {
    command:
      '"$1" -p \'JSON.stringify(JSON.parse(process.env.ROOMOTE_SESSION_EGRESS_SERVICES || "[]").map(s=>({ref:s.secretRef,origin:s.origin,auth:new Request(s.origin,{headers:{authorization:s.headerPrefix+process.env[s.envName]}}).headers.get("authorization")})))\'',
  };
  await hooks['tool.execute.before']({ tool: 'bash' }, { args });
  expect(args.command).toContain('if ! . ');
  // Actual generated harness hook, then the ordinary command with PIPE stdin.
  // No BASH_ENV or SHLVL workaround is supplied.
  return JSON.parse(
    execFileSync(
      '/bin/bash',
      ['-c', args.command, 'model-command', process.execPath],
      { env: modelEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ),
  ) as Array<{ ref: string; origin: string; auth: string }>;
}

beforeEach(async () => {
  dropResponse = false;
  dropAck = false;
  const owner = await userFactory.create();
  sessionId = (
    await sessionFactory.create({ ownerKind: 'user', ownerUserId: owner.id })
  ).id;
  const run = await runFactory.create({
    actingUserId: owner.id,
    status: RunStatus.Running,
  });
  taskId = run.taskId;
  await db
    .insert(sessionTasks)
    .values({ sessionId, taskId, origin: 'direct_launch' });
  auth = {
    tokenType: 'run',
    principal: 'user',
    userId: owner.id,
    runId: run.id,
    version: 1,
  };
  registration = await registerProxyWorkload({
    runId: run.id,
    provider: 'roomote',
  });
  home = mkdtempSync(join(tmpdir(), 'session-proxy-causal-'));
  file = join(home, "session's-services.env");
  worker = WorkerEnv.fromProcessEnv({
    AUTH_TOKEN: 'fixture-run-token',
    TRPC_URL: 'https://api.example.com',
    R_APP_URL: 'https://app.example.com',
  });
  const { tokens, manifest } = buildSessionEgressServiceTokenEnv(
    registration.substitutes,
  );
  worker.acceptSessionEgressDelivery({
    ROOMOTE_SESSION_EGRESS_ADMISSION_MODE: 'authenticated_proxy',
    ROOMOTE_SESSION_EGRESS_GENERATION: String(registration.generation),
    ROOMOTE_SESSION_EGRESS_PROXY_URL: 'https://proxy.example.com',
    ROOMOTE_SESSION_EGRESS_CA_FILE: '/public-ca.pem',
    ROOMOTE_SESSION_PROXY_CAPABILITY: registration.proxyCapability,
    ROOMOTE_SESSION_PROXY_CAPABILITY_EXPIRES_AT:
      registration.proxyCapabilityExpiresAt,
    ROOMOTE_SESSION_EGRESS_SERVICES: JSON.stringify(manifest),
    ...tokens,
  });
  worker.setSessionProxyEnvFile(file);
  writeSessionProxyEnvFile(file, worker.buildSessionEgressClientEnv());
  const runtimeEnv = {
    ...worker.buildSessionEgressClientEnv(),
    R_MODEL: 'openrouter/openai/gpt-4.1-mini',
  };
  const generated = generateOpenCodeConfig({ homeDir: home, runtimeEnv });
  writeFileSync(
    join(generated.openCodeConfigDir, 'opencode.json'),
    generated.configContent,
  );
  modelEnv = { ...buildHarnessCommandEnv(runtimeEnv), HOME: home };
  vi.stubEnv('ROOMOTE_SESSION_PROXY_ENV_FILE', file);
  const module = await import(
    /* @vite-ignore */ pathToFileURL(
      join(home, '.config/opencode/plugins/roomote-tool-safety.js'),
    ).href
  );
  hooks = await module.RoomoteOpenCodeToolSafety();
  sdk.mcpConnections = {
    ...originalMcp,
    syncSessionProxyServices: async (input) => {
      const response = await syncProxyServicesForWorker(auth, input);
      if (!('retryAfterMs' in response)) last = response;
      if (dropResponse) {
        dropResponse = false;
        throw new Error('lost response');
      }
      return response;
    },
    acknowledgeSessionProxyServices: async (generation, revision) => {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, 'utf8')).not.toContain(realKey);
      expect(statSync(`${file}.json`).mode & 0o777).toBe(0o600);
      const clientConfig = JSON.parse(
        readFileSync(`${file}.json`, 'utf8'),
      ).environment;
      expect(JSON.parse(clientConfig.ROOMOTE_SESSION_EGRESS_SERVICES)).toEqual(
        last.services,
      );
      for (const service of last.services)
        expect(readFileSync(file, 'utf8')).toContain(service.envName);
      const result = await acknowledgeProxyServicesForWorker(
        auth,
        generation,
        revision,
      );
      if (dropAck) {
        dropAck = false;
        throw new Error('lost ack response');
      }
      return result;
    },
  };
});

afterEach(async () => {
  sdk.mcpConnections = originalMcp;
  barrier.releaseCredentialWriteBarrier();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  await db.delete(tasks).where(eq(tasks.id, taskId));
  await db.delete(users).where(eq(users.id, auth.userId!));
});

it('first approval in a running zero-grant task reaches its next generated harness command after apply/ack', async () => {
  const originalEnvironment = { ...modelEnv };
  expect(await command()).toEqual([]);
  await approve('First');
  await sync();
  const output = await command();
  expect(output).toHaveLength(1);
  expect(output[0]!.auth).toMatch(/^Bearer rses_/);
  expect(modelEnv).toEqual(originalEnvironment);
  const [row] = await db
    .select()
    .from(sessionEgressWorkloads)
    .where(eq(sessionEgressWorkloads.id, registration.workloadId));
  expect(row!.proxyAppliedRevision).toBe(last.revision);
  expect(row!.proxyAppliedAt).not.toBeNull();
});

it('a second grant reaches the next piped ordinary command while the first token stays usable', async () => {
  await approve('First');
  await sync();
  const first = (await command())[0]!;
  await approve('Second');
  await sync();
  const output = await command();
  expect(output).toHaveLength(2);
  expect(output.find((entry) => entry.ref === first.ref)).toEqual(first);
  for (const entry of output)
    expect(
      await authorizeProxy({
        admissionMode: 'authenticated_proxy',
        workloadId: registration.workloadId,
        proxyCapability: registration.proxyCapability,
        substitute: entry.auth.slice('Bearer '.length),
        destination: { host: new URL(entry.origin).hostname, port: 443 },
        method: 'POST',
        path: '/records',
      }),
    ).toMatchObject({ allowed: true });
});

it('recovers a lost delivery by revoking its unheld receipt, and does not roll back an applied file when the ack response is lost', async () => {
  await approve('First');
  await sync();
  await approve('Second');
  dropResponse = true;
  await expect(sync()).rejects.toThrow('lost response');
  const lost = last.issued[0]!;
  expect(await command()).toHaveLength(1);
  dropAck = true;
  await sync();
  expect(await command()).toHaveLength(2);
  expect(last.issued[0]!.substituteId).not.toBe(lost.substituteId);
  expect(
    await authorizeProxy({
      admissionMode: 'authenticated_proxy',
      workloadId: registration.workloadId,
      proxyCapability: registration.proxyCapability,
      substitute: lost.substitute,
      destination: { host: 'second.example.com', port: 443 },
      method: 'GET',
      path: '/',
    }),
  ).toMatchObject({ allowed: false });
});

it('requires explicit standard-client reconfiguration in an already-running process, rather than mutating its captured env', async () => {
  const script = join(home, 'persistent-client.mjs');
  writeFileSync(
    script,
    `import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
let client = new Request('https://first.example.com');
const original = client;
for await (const action of createInterface({input:process.stdin})) {
  if (action === 'reload') {
    const env = JSON.parse(readFileSync(process.env.ROOMOTE_SESSION_PROXY_CONFIG_FILE, 'utf8')).environment;
    const service = JSON.parse(env.ROOMOTE_SESSION_EGRESS_SERVICES)[0];
    client = new Request(service.origin, {headers:{[service.headerName]:service.headerPrefix+env[service.envName]}});
  }
  console.log(JSON.stringify({authorization:client.headers.get('authorization'),original:original.headers.get('authorization'),captured:Object.keys(process.env).filter(k=>k.startsWith('ROOMOTE_SERVICE_TOKEN_'))}));
}`,
  );
  const args = { command: '"$1" "$2"' };
  await hooks['tool.execute.before']({ tool: 'bash' }, { args });
  const child = spawn(
    '/bin/bash',
    ['-c', args.command, 'model-client', process.execPath, script],
    { env: modelEnv, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const ask = async (action: string) => {
    child.stdin.write(`${action}\n`);
    const line = await lines.next();
    return JSON.parse(line.value!);
  };
  try {
    expect(await ask('inspect')).toEqual({
      authorization: null,
      original: null,
      captured: [],
    });
    await approve('First');
    await sync();
    expect(await ask('inspect')).toEqual({
      authorization: null,
      original: null,
      captured: [],
    });
    const reconfigured = await ask('reload');
    expect(reconfigured.authorization).toMatch(/^Bearer rses_/);
    expect(reconfigured.original).toBeNull();
    expect(reconfigured.captured).toEqual([]);
    child.stdin.end();
    expect((await once(child, 'exit'))[0]).toBe(0);
  } finally {
    child.kill();
    await lines.return?.();
  }
});

it('does not write or acknowledge configuration while snapshot scrubbing has quiesced writers', async () => {
  await approve('First');
  await sync();
  const [before] = await db
    .select()
    .from(sessionEgressWorkloads)
    .where(eq(sessionEgressWorkloads.id, registration.workloadId));
  await barrier.engageCredentialWriteBarrier();
  rmSync(file);
  rmSync(`${file}.json`);
  await approve('Second');
  await sync();
  expect(() => statSync(file)).toThrow();
  await expect(command()).rejects.toThrow();
  const [during] = await db
    .select()
    .from(sessionEgressWorkloads)
    .where(eq(sessionEgressWorkloads.id, registration.workloadId));
  expect(during!.proxyAppliedRevision).toBe(before!.proxyAppliedRevision);
  barrier.releaseCredentialWriteBarrier();
  await sync();
  expect(await command()).toHaveLength(2);
});

it('denies ownerless/user-only or stale-generation synchronization and future acknowledgements', async () => {
  await expect(
    syncProxyServicesForWorker(
      { tokenType: 'auth', userId: auth.userId!, version: 1 },
      { generation: registration.generation, heldSubstituteIds: [] },
    ),
  ).rejects.toThrow('unavailable');
  await expect(
    syncProxyServicesForWorker(auth, {
      generation: registration.generation + 1,
      heldSubstituteIds: [],
    }),
  ).rejects.toThrow('unavailable');
  await expect(
    acknowledgeProxyServicesForWorker(auth, registration.generation, 100),
  ).rejects.toThrow('unavailable');
  await db
    .update(sessions)
    .set({ archivedAt: new Date() })
    .where(eq(sessions.id, sessionId));
  await expect(
    syncProxyServicesForWorker(auth, {
      generation: registration.generation,
      heldSubstituteIds: [],
    }),
  ).rejects.toThrow('unavailable');
});

const shellCases = [
  { name: 'platform default', shell: undefined, configShell: undefined },
  { name: 'SHELL sh', shell: '/bin/sh', configShell: undefined },
  { name: 'SHELL bash', shell: '/bin/bash', configShell: undefined },
  ...(existsSync('/bin/zsh')
    ? [{ name: 'SHELL zsh', shell: '/bin/zsh', configShell: undefined }]
    : []),
  {
    name: 'config shell overrides SHELL',
    shell: '/bin/bash',
    configShell: '/bin/sh',
  },
];
it.skipIf(process.env.SESSION_PROXY_REAL_HARNESS_TEST !== '1').each(shellCases)(
  'runs first and second approvals through an actual persistent OpenCode harness: $name',
  async ({ shell, configShell }) => {
    const expression =
      'JSON.stringify({stdin:(s=>s.isFIFO()?"pipe":s.isSocket()?"socket":"other")(require("node:fs").fstatSync(0)),shell:process.env.ROOMOTE_TEST_SHELL,stale:process.env.ROOMOTE_SERVICE_TOKEN_STALE??null,keep:process.env.KEEP_ME,services:JSON.parse(process.env.ROOMOTE_SESSION_EGRESS_SERVICES||"[]").map(s=>({origin:s.origin,configured:Boolean(process.env[s.envName])}))})';
    const program = `const r=require('node:child_process').spawnSync(process.execPath,['-p',${JSON.stringify(expression)}],{env:process.env,stdio:['pipe','pipe','pipe'],encoding:'utf8'});if(r.status!==0)throw new Error('client failed');process.stdout.write(r.stdout)`;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const fixture = await startOpenCodeCommandFixture(
      home,
      {
        ...modelEnv,
        ...(shell ? { SHELL: shell } : {}),
        ROOMOTE_SERVICE_TOKEN_STALE: 'rses_stale',
        KEEP_ME: 'unrelated',
      },
      `ROOMOTE_TEST_SHELL="$0" ${quote(process.execPath)} -e ${quote(program)}`,
      { shell: configShell },
    );
    try {
      const initial = JSON.parse((await fixture.run()).trim());
      expect(initial.stdin).toMatch(/^(socket|pipe)$/);
      expect(initial.stale).toBeNull();
      expect(initial.keep).toBe('unrelated');
      if (configShell || shell)
        expect(String(initial.shell).split('/').at(-1)).toBe(
          (configShell ?? shell)!.split('/').at(-1),
        );
      expect(initial.services).toEqual([]);
      await approve('First');
      await sync();
      const first = JSON.parse((await fixture.run()).trim());
      expect(first.stale).toBeNull();
      expect(first.keep).toBe('unrelated');
      expect(first.shell).toBe(initial.shell);
      expect(first.services).toEqual([
        { origin: 'https://first.example.com', configured: true },
      ]);
      await approve('Second');
      await sync();
      const second = JSON.parse((await fixture.run()).trim());
      expect(second.stale).toBeNull();
      expect(second.keep).toBe('unrelated');
      expect(second.shell).toBe(initial.shell);
      expect(second.services).toEqual([
        { origin: 'https://first.example.com', configured: true },
        { origin: 'https://second.example.com', configured: true },
      ]);
      expect(JSON.stringify(fixture.received)).toContain('generic SECRET');
      expect(JSON.stringify(fixture.received)).not.toContain(realKey);
      expect(JSON.stringify(fixture.received)).not.toContain(
        registration.proxyCapability,
      );
    } finally {
      await fixture.close();
    }
  },
  90_000,
);
