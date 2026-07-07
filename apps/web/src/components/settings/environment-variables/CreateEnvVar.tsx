import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

import { type CreateEnvVar, createEnvVarSchema } from '@/types';

import { useCreateEnvVar } from '@/hooks/environment-variables';

import {
  Button,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from '@/components/system';

interface CreateEnvVarProps {
  onCreated: () => void;
}

export function CreateEnvVar({ onCreated }: CreateEnvVarProps) {
  const form = useForm<CreateEnvVar>({
    resolver: zodResolver(createEnvVarSchema),
    defaultValues: { name: '', value: '' },
  });

  const createEnvVar = useCreateEnvVar();

  const onSubmit = (data: CreateEnvVar) =>
    createEnvVar.mutate(data, {
      onSuccess: () => {
        form.reset();
        onCreated();
      },
      onError: (error) => form.setError('root', { message: error.message }),
    });

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    form.handleSubmit(onSubmit)(e);
  };

  return (
    <Form {...form}>
      <form onSubmit={handleFormSubmit} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. OPENAI_API_KEY"
                  className="font-mono"
                  {...field}
                  data-1p-ignore
                />
              </FormControl>
              <FormDescription>
                Environment variable name (uppercase letters, numbers, and
                underscores only).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="value"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Value</FormLabel>
              <FormControl>
                <Input secret className="font-mono" {...field} data-1p-ignore />
              </FormControl>
              <FormDescription>
                The environment variable value that will be encrypted and stored
                securely.
              </FormDescription>
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
          <Button type="submit" disabled={createEnvVar.isPending}>
            {createEnvVar.isPending ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
