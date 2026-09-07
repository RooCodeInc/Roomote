import { cn } from '@/lib/utils';

export function SessionSearchSnippet({
  snippet,
  query,
  className,
}: {
  snippet?: string | null;
  query: string;
  className?: string;
}) {
  if (!snippet) return null;

  const normalizedQuery = query.trim();
  const matchAt = snippet
    .toLocaleLowerCase()
    .indexOf(normalizedQuery.toLocaleLowerCase());
  if (!normalizedQuery || matchAt < 0) {
    return (
      <p className={cn('text-sm text-muted-foreground', className)}>
        {snippet}
      </p>
    );
  }

  return (
    <p className={cn('text-sm text-muted-foreground', className)}>
      {snippet.slice(0, matchAt)}
      <mark className="bg-transparent font-medium text-foreground">
        {snippet.slice(matchAt, matchAt + normalizedQuery.length)}
      </mark>
      {snippet.slice(matchAt + normalizedQuery.length)}
    </p>
  );
}
