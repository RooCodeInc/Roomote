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

  const matchAt = snippet
    .toLocaleLowerCase()
    .indexOf(query.toLocaleLowerCase());
  if (!query || matchAt < 0) {
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
        {snippet.slice(matchAt, matchAt + query.length)}
      </mark>
      {snippet.slice(matchAt + query.length)}
    </p>
  );
}
