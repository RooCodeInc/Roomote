import {
  db,
  eq,
  runFactory,
  taskFactory,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import {
  CUSTOM_SKILL_MAX_COUNT,
  CUSTOM_SKILL_MAX_DOCUMENT_BYTES,
  CUSTOM_SKILL_MAX_RUNTIME_BYTES,
  getCustomSkillBundleByteLength,
  renderManualSkillMarkdown,
  RunStatus,
  TaskPayloadKind,
  type RunTokenContext,
} from '@roomote/types';

const { listDefinitions } = vi.hoisted(() => ({ listDefinitions: vi.fn() }));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  listInstanceSkillDefinitions: listDefinitions,
}));

import { instanceSkillsRouter } from './instance-skills';

const definition = {
  name: 'runtime-guide',
  description: 'Use for runtime testing',
  content: '# Runtime guide\nFollow these steps.\n',
  document: null,
  resources: [],
};

describe('instanceSkills runtime authorization (real database)', () => {
  const taskIds: string[] = [];

  async function createRun(status = RunStatus.Running) {
    const task = await taskFactory.create();
    taskIds.push(task.id);
    const run = await runFactory.create({
      taskId: task.id,
      payloadKind: TaskPayloadKind.StandardTask,
      status,
      actingUserId: null,
      payload: { description: 'Instance skill runtime test' },
    });
    return run.id;
  }

  function caller(runId: number, actorless = false) {
    const auth: RunTokenContext = actorless
      ? {
          runId,
          userId: null,
          principal: 'deployment',
          tokenType: 'run',
          version: 1,
        }
      : {
          runId,
          userId: 'mint-time-user',
          principal: 'user',
          tokenType: 'run',
          version: 1,
        };
    return instanceSkillsRouter.createCaller({ auth });
  }

  beforeEach(() => {
    listDefinitions.mockReset().mockResolvedValue([definition]);
  });

  afterEach(async () => {
    for (const taskId of taskIds.splice(0)) {
      await db.delete(taskRuns).where(eq(taskRuns.taskId, taskId));
      await db.delete(tasks).where(eq(tasks.id, taskId));
    }
  });

  it('returns definitions for an actual nonterminal run', async () => {
    await expect(caller(await createRun()).listForRuntime()).resolves.toEqual([
      definition,
    ]);
  });

  it('allows actorless deployment runs', async () => {
    await expect(
      caller(await createRun(), true).listForRuntime(),
    ).resolves.toEqual([definition]);
  });

  it('rejects missing authentication', async () => {
    await expect(
      instanceSkillsRouter.createCaller({ auth: null }).listForRuntime(),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(listDefinitions).not.toHaveBeenCalled();
  });

  it('rejects user tokens without a runtime identity', async () => {
    await expect(
      instanceSkillsRouter
        .createCaller({
          auth: { userId: 'user', tokenType: 'auth', version: 1 },
        })
        .listForRuntime(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listDefinitions).not.toHaveBeenCalled();
  });

  it('rejects a run that does not exist', async () => {
    const runId = await createRun();
    await db.delete(taskRuns).where(eq(taskRuns.id, runId));
    await expect(caller(runId).listForRuntime()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(listDefinitions).not.toHaveBeenCalled();
  });

  it('cannot select a foreign run through arbitrary input', async () => {
    const ownRunId = await createRun();
    const foreignRunId = await createRun();
    await expect(
      // @ts-expect-error Runtime callers cannot supply identity fields.
      caller(ownRunId).listForRuntime({ runId: foreignRunId }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(listDefinitions).not.toHaveBeenCalled();
  });

  it.each([RunStatus.Completed, RunStatus.Failed, RunStatus.Canceled])(
    'rejects terminal run status %s',
    async (status) => {
      await expect(
        caller(await createRun(status)).listForRuntime(),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(listDefinitions).not.toHaveBeenCalled();
    },
  );

  it('filters invalid, duplicate, and oversized definitions and caps the count', async () => {
    listDefinitions.mockResolvedValue([
      { ...definition, name: '../unsafe' },
      { ...definition, content: 'é'.repeat(CUSTOM_SKILL_MAX_DOCUMENT_BYTES) },
      definition,
      definition,
      ...Array.from({ length: CUSTOM_SKILL_MAX_COUNT + 1 }, (_, index) => ({
        ...definition,
        name: `skill-${index}`,
      })),
    ]);
    const result = await caller(await createRun()).listForRuntime();
    expect(result).toHaveLength(CUSTOM_SKILL_MAX_COUNT);
    expect(result[0]).toEqual(definition);
    expect(new Set(result.map((skill) => skill.name)).size).toBe(result.length);
  });

  it('bounds the rendered document including frontmatter', async () => {
    const overhead =
      Buffer.byteLength(
        renderManualSkillMarkdown({ ...definition, content: 'x' }),
      ) - 1;
    const bounded = {
      ...definition,
      content: 'x'.repeat(CUSTOM_SKILL_MAX_DOCUMENT_BYTES - overhead),
    };
    listDefinitions.mockResolvedValue([
      bounded,
      {
        ...bounded,
        name: 'too-large',
        content: `${bounded.content}more than the boundary`,
      },
    ]);
    const result = await caller(await createRun()).listForRuntime();
    expect(result).toHaveLength(1);
    expect(Buffer.byteLength(renderManualSkillMarkdown(result[0]!))).toBe(
      CUSTOM_SKILL_MAX_DOCUMENT_BYTES,
    );
  });

  it('bounds the aggregate runtime catalog including supporting resources', async () => {
    const resourceContent = Buffer.alloc(512 * 1024, 'x').toString('base64');
    listDefinitions.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => ({
        ...definition,
        name: `resource-skill-${index}`,
        resources: [
          {
            path: 'assets/data.bin',
            contentBase64: resourceContent,
            executable: false,
          },
        ],
      })),
    );

    const result = await caller(await createRun()).listForRuntime();

    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(20);
    expect(
      result.reduce(
        (total, skill) => total + getCustomSkillBundleByteLength(skill),
        0,
      ),
    ).toBeLessThanOrEqual(CUSTOM_SKILL_MAX_RUNTIME_BYTES);
  });
});
