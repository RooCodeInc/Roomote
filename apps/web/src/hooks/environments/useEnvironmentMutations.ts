'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { useTRPC } from '@/trpc/client';

export function useCreateEnvironment() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.environments.create.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.environments.list.queryKey(),
          });
          toast.success('Environment created successfully');
        } else {
          toast.error(result.error);
        }
      },
      onError: () => {
        toast.error('Failed to create environment');
      },
    }),
  );
}

export function useUpdateEnvironment() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.environments.update.mutationOptions({
      onSuccess: (result, variables) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.environments.list.queryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: trpc.environments.byId.queryKey({ id: variables.id }),
          });
          queryClient.invalidateQueries({
            queryKey: trpc.environments.listConfigVersions.queryKey({
              environmentId: variables.id,
            }),
          });
          toast.success('Environment updated successfully');
        } else {
          toast.error(result.error);
        }
      },
      onError: () => {
        toast.error('Failed to update environment');
      },
    }),
  );
}

export function useDeleteEnvironment() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.environments.delete.mutationOptions({
      onSuccess: (result, variables) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.environments.list.queryKey(),
          });
          queryClient.removeQueries({
            queryKey: trpc.environments.byId.queryKey({ id: variables.id }),
          });
          queryClient.removeQueries({
            queryKey: trpc.environments.listConfigVersions.queryKey({
              environmentId: variables.id,
            }),
          });
          toast.success('Environment deleted successfully');
        } else {
          toast.error(result.error);
        }
      },
      onError: () => {
        toast.error('Failed to delete environment');
      },
    }),
  );
}

export function useDuplicateEnvironment() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  return useMutation(
    trpc.environments.duplicate.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          queryClient.invalidateQueries({
            queryKey: trpc.environments.list.queryKey(),
          });
          toast.success('Environment duplicated successfully');
        } else {
          toast.error(result.error);
        }
      },
      onError: () => {
        toast.error('Failed to duplicate environment');
      },
    }),
  );
}
