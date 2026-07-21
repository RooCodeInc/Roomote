'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Lock, KeyRound, Pencil } from '@/components/system';

import type { EnvironmentVariable } from '@roomote/db';

import { useTRPC } from '@/trpc/client';

import { useEnvVars, useDeleteEnvVar } from '@/hooks/environment-variables';

import { Badge, Button, Skeleton } from '@/components/system';
import { Loading } from '@/components/layout';
import { Section } from '@/components/settings';

import {
  CreateEnvVarDialog,
  UpdateEnvVarDialog,
} from './environment-variables';

export function EnvVars() {
  const [createEnvVar, setCreateEnvVar] = useState<boolean>(false);

  const [editEnvVar, setEditEnvVar] =
    useState<Omit<EnvironmentVariable, 'value'>>();

  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data: envVars = [], isPending } = useEnvVars();

  const deleteEnvVar = useDeleteEnvVar();

  return (
    <>
      <Section
        icon={KeyRound}
        title="Deployment Environment Variables"
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setCreateEnvVar(true)}
          >
            <Plus />
            Add
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Encrypted variables available to tasks in every environment.
        </p>
        {isPending ? (
          <table className="w-full">
            <tbody>
              {Array.from({ length: 3 }).map((_, i) => (
                <tr
                  key={i}
                  className="text-sm text-left border-b border-border last:border-none"
                >
                  <th>
                    <Skeleton className="h-4 w-32 my-2" />
                  </th>
                  <th>
                    <Skeleton className="h-5 w-24 rounded-full" />
                  </th>
                  <td className="text-right py-1 w-30">
                    <Skeleton className="h-8 w-16 inline-block" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : envVars.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No environment variables defined yet.
          </p>
        ) : (
          <table className="w-full">
            <tbody>
              {envVars.map((envVar) => (
                <tr
                  key={envVar.id}
                  className="text-sm text-left border-b border-border last:border-none"
                >
                  <th className="font-mono">{envVar.name}</th>
                  <th>
                    <Badge variant="outline">
                      <Lock className="size-2 text-muted-foreground" />
                      &bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;
                    </Badge>
                  </th>
                  <td className="text-right py-1 w-30">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditEnvVar(envVar)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        if (
                          confirm(
                            'Are you sure you want to delete this environment variable? This action cannot be undone.',
                          )
                        ) {
                          await deleteEnvVar.mutateAsync({ id: envVar.id });
                        }
                      }}
                      disabled={
                        deleteEnvVar.isPending &&
                        deleteEnvVar.variables?.id === envVar.id
                      }
                    >
                      {deleteEnvVar.isPending &&
                      deleteEnvVar.variables?.id === envVar.id ? (
                        <Loading />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <CreateEnvVarDialog
        open={createEnvVar}
        onOpenChange={(open) => setCreateEnvVar(open)}
        onCreated={() => {
          setCreateEnvVar(false);
          queryClient.invalidateQueries({
            queryKey: trpc.environmentVariables.list.queryKey(),
          });
        }}
      />
      <UpdateEnvVarDialog
        open={!!editEnvVar}
        onOpenChange={(open) => setEditEnvVar(open ? editEnvVar : undefined)}
        envVar={editEnvVar}
        onUpdated={() => {
          setEditEnvVar(undefined);
          queryClient.invalidateQueries({
            queryKey: trpc.environmentVariables.list.queryKey(),
          });
        }}
      />
    </>
  );
}
