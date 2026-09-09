import { ROOMOTE_MCP_ID } from '@roomote/types';
import type { FastAgentTurnAdapter } from '../fast-agent-conversation';
import {
  getFastSourceControlToolTarget,
  preflightFastSourceControl,
  sourceControlConnectionArgsSchema,
} from '../fast-agent-source-control';

describe('Fast source-control preflight', () => {
  it.each([undefined, false])(
    'preserves legacy operation checks when rollout is %s',
    async (sourceControlConnectionEnabled) => {
      const getSourceControlReadiness = vi.fn();
      const adapter = {
        sourceControlConnectionEnabled,
        getSourceControlReadiness,
        launchTask: vi.fn(),
        postReply: vi.fn(),
      } as FastAgentTurnAdapter;
      expect(
        await preflightFastSourceControl(adapter, 'actor', {
          capability: 'repository',
        }),
      ).toBeUndefined();
      expect(getSourceControlReadiness).not.toHaveBeenCalled();
      delete adapter.getSourceControlReadiness;
      expect(
        await preflightFastSourceControl(adapter, 'actor', {
          capability: 'source_control_tool',
        }),
      ).toBeUndefined();
    },
  );
  it.each([undefined, false])(
    'enforces continuation readiness when rollout becomes %s after admission',
    async (sourceControlConnectionEnabled) => {
      const getSourceControlReadiness = vi
        .fn()
        .mockResolvedValue({ status: 'forbidden' });
      const adapter = {
        sourceControlConnectionEnabled,
        forceFreshSourceControlDiscovery: true,
        getSourceControlReadiness,
        launchTask: vi.fn(),
        postReply: vi.fn(),
      } as FastAgentTurnAdapter;
      for (const capability of ['repository', 'source_control_tool'] as const) {
        const target = { capability, repositoryFullName: 'acme/api' };
        expect(
          await preflightFastSourceControl(adapter, 'original-actor', target),
        ).toMatchObject({
          success: false,
          readiness: { status: 'forbidden' },
        });
        expect(getSourceControlReadiness).toHaveBeenLastCalledWith({
          actorUserId: 'original-actor',
          target,
        });
      }
      expect(getSourceControlReadiness).toHaveBeenCalledTimes(2);
      delete adapter.getSourceControlReadiness;
      expect(
        await preflightFastSourceControl(adapter, 'original-actor', {
          capability: 'repository',
        }),
      ).toMatchObject({
        success: false,
        readiness: { status: 'discovery_unavailable' },
      });
    },
  );
  it.each(['github', 'gitlab', 'gitea', 'ado', 'bitbucket'])(
    'checks %s tools independently of discovery',
    (provider) => {
      expect(
        getFastSourceControlToolTarget({
          integrationId: provider,
          toolName: 'read',
          args: { owner: 'acme', repo: 'api' },
        }),
      ).toEqual({
        provider,
        repositoryFullName: 'acme/api',
        capability: 'source_control_tool',
      });
    },
  );

  it('checks the native Roomote source-control tool without gating unrelated integrations', () => {
    expect(
      getFastSourceControlToolTarget({
        integrationId: ROOMOTE_MCP_ID,
        toolName: 'manage_source_control',
        args: {
          sourceControlProvider: 'gitlab',
          repositoryFullName: 'acme/api',
        },
      }),
    ).toEqual({
      provider: 'gitlab',
      repositoryFullName: 'acme/api',
      capability: 'source_control_tool',
    });
    expect(
      getFastSourceControlToolTarget({
        integrationId: ROOMOTE_MCP_ID,
        toolName: 'manage_tasks',
        args: {},
      }),
    ).toBeUndefined();
    expect(
      getFastSourceControlToolTarget({
        integrationId: 'notion',
        toolName: 'search',
        args: {},
      }),
    ).toBeUndefined();
  });

  it('requires a capability and rejects unsupported providers', () => {
    expect(
      sourceControlConnectionArgsSchema.safeParse({ target: {} }).success,
    ).toBe(false);
    expect(
      sourceControlConnectionArgsSchema.safeParse({
        target: { capability: 'repository', provider: 'unknown' },
      }).success,
    ).toBe(false);
  });

  it('fails closed on missing readiness and redacts thrown provider errors', async () => {
    const adapter = {
      sourceControlConnectionEnabled: true,
      launchTask: vi.fn(),
      postReply: vi.fn(),
    } as FastAgentTurnAdapter;
    const target = {
      capability: 'repository' as const,
      repositoryFullName: 'acme/api',
    };
    expect(
      await preflightFastSourceControl(adapter, 'actor', target),
    ).toMatchObject({
      success: false,
      readiness: { status: 'discovery_unavailable' },
    });
    adapter.getSourceControlReadiness = vi.fn(async () => {
      throw new Error('token=secret');
    });
    expect(
      JSON.stringify(
        await preflightFastSourceControl(adapter, 'actor', target),
      ),
    ).not.toContain('secret');
  });

  it('rechecks authoritative readiness on every operation and preserves the actor and target', async () => {
    const getSourceControlReadiness = vi
      .fn()
      .mockResolvedValueOnce({ status: 'ready' })
      .mockResolvedValueOnce({ status: 'repository_unavailable' });
    const adapter = {
      sourceControlConnectionEnabled: true,
      launchTask: vi.fn(),
      postReply: vi.fn(),
      getSourceControlReadiness,
    } as FastAgentTurnAdapter;
    const target = {
      capability: 'repository' as const,
      repositoryFullName: 'acme/api',
    };
    expect(
      await preflightFastSourceControl(adapter, 'original-actor', target),
    ).toBeUndefined();
    expect(
      await preflightFastSourceControl(adapter, 'original-actor', target),
    ).toMatchObject({
      success: false,
      readiness: { status: 'repository_unavailable' },
    });
    expect(getSourceControlReadiness).toHaveBeenCalledTimes(2);
    expect(getSourceControlReadiness).toHaveBeenLastCalledWith({
      actorUserId: 'original-actor',
      target,
    });
  });
});
