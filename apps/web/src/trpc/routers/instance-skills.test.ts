import { randomUUID } from 'node:crypto';
import {
  db,
  environmentFactory,
  environments,
  eq,
  inArray,
  userFactory,
  users,
} from '@roomote/db/server';
import type { UserAuthSuccess } from '@/types';

const { loadMarketplaceSkillBundleMock } = vi.hoisted(() => ({
  loadMarketplaceSkillBundleMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  loadMarketplaceSkillBundle: loadMarketplaceSkillBundleMock,
}));

// createCaller supplies auth directly; keep the real protected procedure and DB.
vi.mock('@/lib/server', () => ({ authorize: vi.fn() }));

import { instanceSkillsRouter } from './instance-skills';

const userIds: string[] = [];
const environmentIds: string[] = [];
const skillIds: string[] = [];
let adminAuth: UserAuthSuccess;
let memberAuth: UserAuthSuccess;
let otherAuth: UserAuthSuccess;

function caller(auth: UserAuthSuccess) {
  return instanceSkillsRouter.createCaller({ auth });
}

function definition() {
  return {
    name: `test-${randomUUID()}`,
    description: 'Review an example change',
    content: 'Read the diff and report concrete findings.\n',
  };
}

async function createActor(role: 'admin' | 'member') {
  const user = await userFactory.create({ role });
  userIds.push(user.id);
  return {
    success: true,
    userType: 'user',
    userId: user.id,
    isAdmin: role === 'admin',
  } as UserAuthSuccess;
}

async function createSkill(auth = memberAuth, input = definition()) {
  const result = await caller(auth).create(input);
  skillIds.push(result.skillId);
  return { skillId: result.skillId, input };
}

beforeEach(async () => {
  loadMarketplaceSkillBundleMock.mockReset().mockResolvedValue({
    name: 'marketplace-skill',
    description: 'Use the marketplace skill.',
    content: '# Marketplace instructions',
    document:
      '---\nname: marketplace-skill\ndescription: Use the marketplace skill.\n---\n\n# Marketplace instructions',
    source: 'owner/catalog',
    revision: 'a'.repeat(40),
    resources: [
      {
        path: 'guides/setup.md',
        contentBase64: Buffer.from('# Setup').toString('base64'),
        executable: false,
      },
    ],
  });
  adminAuth = await createActor('admin');
  memberAuth = await createActor('member');
  otherAuth = await createActor('member');
});

afterEach(async () => {
  for (const skillId of skillIds.splice(0)) {
    // Successful deletion tests remove their IDs from this cleanup list.
    await caller(adminAuth).delete({ skillId });
  }
  if (environmentIds.length) {
    await db
      .delete(environments)
      .where(inArray(environments.id, environmentIds.splice(0)));
  }
  if (userIds.length) {
    await db.delete(users).where(inArray(users.id, userIds.splice(0)));
  }
});

describe('instanceSkills router with real database authorization', () => {
  it('lets a member create and all active members list and read the skill', async () => {
    const { skillId, input } = await createSkill();

    for (const auth of [memberAuth, otherAuth, adminAuth]) {
      expect(await caller(auth).list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: input.name,
            createdByName: expect.any(String),
          }),
        ]),
      );
      expect(await caller(auth).get({ skillId })).toMatchObject({
        ...input,
        canManage: auth.userId !== otherAuth.userId,
      });
    }
  });

  it('lets a member install a marketplace bundle globally without an environment', async () => {
    const result = await caller(memberAuth).installMarketplace({
      skillId: 'owner/catalog@marketplace-skill',
    });
    skillIds.push(result.skillId);

    expect(loadMarketplaceSkillBundleMock).toHaveBeenCalledWith(
      'owner/catalog',
      'marketplace-skill',
    );
    expect(
      await caller(otherAuth).get({ skillId: result.skillId }),
    ).toMatchObject({
      name: 'marketplace-skill',
      marketplaceSource: 'owner/catalog',
      marketplaceRevision: 'a'.repeat(40),
      resources: [expect.objectContaining({ path: 'guides/setup.md' })],
      canManage: false,
    });
    await expect(
      caller(otherAuth).delete({ skillId: result.skillId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(memberAuth).installMarketplace({
        skillId: 'owner/catalog@marketplace-skill',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each([false, true])(
    'rejects another member updating or deleting, including forged isAdmin=%s',
    async (isAdmin) => {
      const { skillId, input } = await createSkill();
      const other = caller({ ...otherAuth, isAdmin });

      await expect(
        other.update({ skillId, ...definition() }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(other.delete({ skillId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await caller(memberAuth).get({ skillId })).toMatchObject(input);
    },
  );

  it.each(['creator', 'admin'] as const)(
    'lets the %s update and delete a skill',
    async (actor) => {
      const { skillId, input } = await createSkill();
      // DB role, not a stale auth flag, determines admin privileges.
      const auth =
        actor === 'creator' ? memberAuth : { ...adminAuth, isAdmin: false };
      const updated = {
        ...input,
        name: `${input.name}-updated`,
        description: 'Updated description',
        content: 'Updated review instructions.\n',
      };
      await caller(auth).update({ skillId, ...updated });
      expect(await caller(otherAuth).get({ skillId })).toMatchObject(updated);
      await caller(auth).delete({ skillId });
      skillIds.splice(skillIds.indexOf(skillId), 1);
      expect(await caller(otherAuth).list()).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: updated.name }),
        ]),
      );
      await expect(caller(otherAuth).get({ skillId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    },
  );

  it.each(['unknown', 'deleted-member', 'deleted-admin'] as const)(
    'denies every operation for an %s actor even with isAdmin=true',
    async (state) => {
      const { skillId, input } = await createSkill();
      let auth: UserAuthSuccess = {
        ...otherAuth,
        userId: randomUUID(),
        isAdmin: true,
      };
      if (state !== 'unknown') {
        const deleted =
          state === 'deleted-member' ? memberAuth : await createActor('admin');
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, deleted.userId));
        auth = { ...deleted, isAdmin: true };
      }
      const denied = caller(auth);
      for (const operation of [
        () => denied.list(),
        () => denied.get({ skillId }),
        () => denied.create(definition()),
        () => denied.update({ skillId, ...definition() }),
        () => denied.delete({ skillId }),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await caller(adminAuth).get({ skillId })).toMatchObject(input);
    },
  );

  it('does not mutate legacy environment config or verification during CRUD', async () => {
    const legacy = await environmentFactory.create({
      createdByUserId: memberAuth.userId,
      isVerified: true,
      config: {
        name: 'Legacy environment',
        repositories: [{ repository: 'example/repository' }],
        manualSkills: [definition()],
      },
    });
    environmentIds.push(legacy.id);
    const readEnvironment = () =>
      db.query.environments.findFirst({
        where: eq(environments.id, legacy.id),
      });
    const before = await readEnvironment();
    const { skillId } = await createSkill();
    await caller(memberAuth).list();
    await caller(memberAuth).get({ skillId });
    await caller(memberAuth).update({ skillId, ...definition() });
    await caller(memberAuth).delete({ skillId });
    skillIds.splice(skillIds.indexOf(skillId), 1);
    expect(await readEnvironment()).toEqual(before);
  });

  it.each(['environmentId', 'environmentIds', 'environments'])(
    'rejects the legacy %s field rather than stripping it from router inputs',
    async (field) => {
      const { skillId, input } = await createSkill();
      const extra = {
        [field]: field === 'environmentId' ? randomUUID() : [randomUUID()],
      };
      const member = caller(memberAuth);
      for (const operation of [
        () => member.create({ ...definition(), ...extra }),
        () => member.update({ skillId, ...definition(), ...extra }),
        () => member.get({ skillId, ...extra }),
        () => member.delete({ skillId, ...extra }),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
      }
      expect(await member.get({ skillId })).toMatchObject(input);
    },
  );

  it('enforces the full rendered-size validation on updates without changing the saved skill', async () => {
    const { skillId, input } = await createSkill();
    await expect(
      caller(memberAuth).update({
        ...input,
        skillId,
        content: 'x'.repeat(64 * 1024),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await caller(memberAuth).get({ skillId })).toMatchObject(input);
  });
});
