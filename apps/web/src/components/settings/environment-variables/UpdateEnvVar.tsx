import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import type { EnvironmentVariable } from '@roomote/db';

import { type UpdateEnvVar, updateEnvVarSchema } from '@/types';

import { useUpdateEnvVar } from '@/hooks/environment-variables';

import {
  Button,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from '@/components/system';

interface UpdateEnvVarProps {
  envVar: Omit<EnvironmentVariable, 'value'>;
  onUpdated: () => void;
}

export function UpdateEnvVar({ envVar, onUpdated }: UpdateEnvVarProps) {
  const form = useForm<UpdateEnvVar>({
    resolver: zodResolver(updateEnvVarSchema),
    defaultValues: { value: '' },
  });

  const updateEnvVar = useUpdateEnvVar();

  const onSubmit = (data: UpdateEnvVar) =>
    updateEnvVar.mutate(
      { id: envVar.id, value: data.value },
      {
        onSuccess: () => {
          form.reset();
          onUpdated();
        },
        onError: (error) => form.setError('root', { message: error.message }),
      },
    );

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    form.handleSubmit(onSubmit)(e);
  };

  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit} className="space-y-4">
        <FormItem className="cursor-not-allowed">
          <FormLabel>Name</FormLabel>
          <Input value={envVar.name} disabled className="font-mono" />
        </FormItem>

        <FormField
          control={form.control}
          name="value"
          render={({ field }) => (
            <FormItem>
              <FormLabel>New Value</FormLabel>
              <FormControl>
                <Input secret className="font-mono" {...field} data-1p-ignore />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {form.formState.errors.root && (
          <div className="text-sm text-destructive max-w-sm overflow-hidden text-ellipsis">
            {form.formState.errors.root.message}
          </div>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={updateEnvVar.isPending}>
            {updateEnvVar.isPending ? 'Updating...' : 'Update'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
