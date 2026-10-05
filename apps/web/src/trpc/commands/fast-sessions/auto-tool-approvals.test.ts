import type { UserAuthSuccess } from '@/types';

const mocks = vi.hoisted(() => ({
  experiment: vi.fn(async () => true),
  getAuto: vi.fn(),
  setAuto: vi.fn(),
  resolveModel: vi.fn(async () => ({ kind: 'judgment' }) as unknown),
}));

vi.mock('@roomote/db/server', () => ({
  isDeploymentExperimentEnabled: mocks.experiment,
  getIntegrationToolAutoForSession: mocks.getAuto,
  setIntegrationToolAutoForSession: mocks.setAuto,
}));
vi.mock(
  '@roomote/cloud-agents/server/integration-tool-auto-evaluation',
  () => ({ AUTO_DECISION_REQUIREMENTS: { excludeRoomoteModel: true } }),
);
vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  resolveDecisionModel: mocks.resolveModel,
}));

import {
  getFastSessionAutoToolApprovalsCommand,
  isAutoToolApprovalsExperimentEnabled,
  setFastSessionAutoToolApprovalsCommand,
} from './auto-tool-approvals';

const auth = {
  userId: 'user-1',
  nightlyExperimentsEnabled: true,
} as UserAuthSuccess;
const sessionId = '6a1f8f1e-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.experiment.mockResolvedValue(true);
  mocks.resolveModel.mockResolvedValue({ kind: 'judgment' });
  mocks.getAuto.mockResolvedValue({ enabled: false, suspended: false });
  mocks.setAuto.mockResolvedValue(true);
});

describe('isAutoToolApprovalsExperimentEnabled', () => {
  it('needs both the nightly opt-in and the Auto experiment', async () => {
    await expect(isAutoToolApprovalsExperimentEnabled(auth)).resolves.toBe(
      true,
    );
    expect(mocks.experiment).toHaveBeenCalledWith(
      'integrationToolAutoApprovals',
    );

    mocks.experiment.mockResolvedValue(false);
    await expect(isAutoToolApprovalsExperimentEnabled(auth)).resolves.toBe(
      false,
    );

    mocks.experiment.mockResolvedValue(true);
    await expect(
      isAutoToolApprovalsExperimentEnabled({
        ...auth,
        nightlyExperimentsEnabled: false,
      }),
    ).resolves.toBe(false);
  });
});

describe('getFastSessionAutoToolApprovalsCommand', () => {
  it('is off for a session that has not started, and for one nobody turned it on in', async () => {
    await expect(
      getFastSessionAutoToolApprovalsCommand(auth, {}),
    ).resolves.toEqual({ available: true, enabled: false, suspended: false });
    expect(mocks.getAuto).not.toHaveBeenCalled();

    await expect(
      getFastSessionAutoToolApprovalsCommand(auth, { sessionId }),
    ).resolves.toEqual({ available: true, enabled: false, suspended: false });
    expect(mocks.getAuto).toHaveBeenCalledWith({
      sessionId,
      userId: 'user-1',
    });
  });

  it("reports the owner's choice and whether Auto paused itself", async () => {
    mocks.getAuto.mockResolvedValue({ enabled: true, suspended: true });
    await expect(
      getFastSessionAutoToolApprovalsCommand(auth, { sessionId }),
    ).resolves.toEqual({ available: true, enabled: true, suspended: true });
  });

  it('is not available without a hosted judgment model', async () => {
    mocks.resolveModel.mockResolvedValue({ kind: 'helper', model: 'm' });
    await expect(
      getFastSessionAutoToolApprovalsCommand(auth, {}),
    ).resolves.toMatchObject({ available: false });
    mocks.resolveModel.mockRejectedValue(new Error('no model'));
    await expect(
      getFastSessionAutoToolApprovalsCommand(auth, {}),
    ).resolves.toMatchObject({ available: false });
  });

  it('offers nothing outside the experiment and reads no session', async () => {
    mocks.experiment.mockResolvedValue(false);
    await expect(
      getFastSessionAutoToolApprovalsCommand(auth, { sessionId }),
    ).resolves.toEqual({ available: false, enabled: false, suspended: false });
    expect(mocks.getAuto).not.toHaveBeenCalled();
  });

  it("does not reveal another user's session", async () => {
    mocks.getAuto.mockResolvedValue(null);
    await expect(
      getFastSessionAutoToolApprovalsCommand(auth, { sessionId }),
    ).rejects.toThrow('Session not found');
  });
});

describe('setFastSessionAutoToolApprovalsCommand', () => {
  it('turns Auto on for the owner and returns the new state', async () => {
    mocks.getAuto.mockResolvedValue({ enabled: true, suspended: false });
    await expect(
      setFastSessionAutoToolApprovalsCommand(auth, {
        sessionId,
        enabled: true,
      }),
    ).resolves.toEqual({ available: true, enabled: true, suspended: false });
    expect(mocks.setAuto).toHaveBeenCalledWith({
      sessionId,
      userId: 'user-1',
      enabled: true,
    });
  });

  it('refuses to turn Auto on while nothing can assess calls, but always turns it off', async () => {
    mocks.resolveModel.mockResolvedValue(null);
    await expect(
      setFastSessionAutoToolApprovalsCommand(auth, {
        sessionId,
        enabled: true,
      }),
    ).rejects.toThrow('Auto isn’t available yet.');
    expect(mocks.setAuto).not.toHaveBeenCalled();

    await expect(
      setFastSessionAutoToolApprovalsCommand(auth, {
        sessionId,
        enabled: false,
      }),
    ).resolves.toMatchObject({ enabled: false });
    expect(mocks.setAuto).toHaveBeenCalledWith({
      sessionId,
      userId: 'user-1',
      enabled: false,
    });
  });

  it('changes nothing outside the experiment or for a session that is not the user’s', async () => {
    mocks.experiment.mockResolvedValue(false);
    await expect(
      setFastSessionAutoToolApprovalsCommand(auth, {
        sessionId,
        enabled: true,
      }),
    ).rejects.toThrow('Auto tool approvals are not enabled.');
    expect(mocks.setAuto).not.toHaveBeenCalled();

    mocks.experiment.mockResolvedValue(true);
    mocks.setAuto.mockResolvedValue(false);
    await expect(
      setFastSessionAutoToolApprovalsCommand(auth, {
        sessionId,
        enabled: true,
      }),
    ).rejects.toThrow('Session not found');
  });
});
