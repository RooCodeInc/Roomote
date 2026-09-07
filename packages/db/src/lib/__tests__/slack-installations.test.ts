import {
  db,
  eq,
  findActiveSlackInstallationForChannel,
  slackInstallationChannels,
  slackInstallationFactory,
  slackInstallations,
  userFactory,
  users,
} from '../../server';

describe('findActiveSlackInstallationForChannel', () => {
  let userId: string;

  beforeEach(async () => {
    userId = (await userFactory.create()).id;
  });

  afterEach(async () => {
    await db
      .delete(slackInstallations)
      .where(eq(slackInstallations.installedByUserId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  async function installation(isActive = true) {
    return slackInstallationFactory.create({
      installedByUserId: userId,
      isActive,
    });
  }

  async function map(slackInstallationId: string) {
    await db.insert(slackInstallationChannels).values({
      slackInstallationId,
      channelId: 'C_MANAGER',
    });
  }

  it('selects owner B when A was created first and both are active', async () => {
    await installation();
    const owner = await installation();
    await map(owner.id);
    expect(await findActiveSlackInstallationForChannel('C_MANAGER')).toEqual(
      owner,
    );
  });

  it('falls back to the sole active installation only without channel mappings', async () => {
    await installation(false);
    const owner = await installation();
    expect(await findActiveSlackInstallationForChannel('C_MANAGER')).toEqual(
      owner,
    );
  });

  it('returns null for an unmapped channel with no active installations', async () => {
    await installation(false);
    expect(await findActiveSlackInstallationForChannel('C_MANAGER')).toBeNull();
  });

  it('never guesses between active installations for an unmapped channel', async () => {
    await installation();
    await installation();
    expect(await findActiveSlackInstallationForChannel('C_MANAGER')).toBeNull();
  });

  it('does not fall back to an active installation when the recorded owner is inactive', async () => {
    await installation();
    await map((await installation(false)).id);
    expect(await findActiveSlackInstallationForChannel('C_MANAGER')).toBeNull();
  });

  it.each([true, false])(
    'rejects ambiguous ownership even when second owner active=%s',
    async (isActive) => {
      await map((await installation()).id);
      await map((await installation(isActive)).id);
      expect(
        await findActiveSlackInstallationForChannel('C_MANAGER'),
      ).toBeNull();
    },
  );
});
