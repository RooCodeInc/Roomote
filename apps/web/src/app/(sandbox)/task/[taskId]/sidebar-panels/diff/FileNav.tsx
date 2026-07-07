import { type FileDiff, type RepoDiff } from '../../hooks';

function FileNavEntry({
  file,
  repoName,
  onSelect,
}: {
  file: FileDiff;
  repoName: string;
  onSelect: (repoName: string, path: string) => void;
}) {
  const name = file.path.split('/').pop() ?? file.path;
  const dir = file.path.slice(0, -name.length);
  return (
    <button
      key={file.path}
      type="button"
      onClick={() => onSelect(repoName, file.path)}
      title={file.path}
      className="flex w-full items-baseline cursor-pointer hover:opacity-50 gap-1 rounded py-1 text-left hover:bg-accent transition-colors"
    >
      <span className="grow truncate">
        <span className="shrink-0 font-medium">{name}</span>
        <span className="text-muted-foreground"> {dir}</span>
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        <span className="text-green-600">+{file.additions}</span>{' '}
        <span className="text-red-500">-{file.deletions}</span>
      </span>
    </button>
  );
}

export function FileNav({
  repos,
  onSelect,
}: {
  repos: RepoDiff[];
  onSelect: (repoName: string, path: string) => void;
}) {
  const hasMultipleRepos = repos.length > 1;

  return (
    <nav className="hidden @[700px]:flex h-full min-h-0 w-60 shrink-0 flex-col gap-0.5 overflow-y-auto overflow-x-clip scroll-thin pb-4 pl-1 pt-1 text-xs">
      {repos.map((repo) => (
        <div key={repo.repoName}>
          {hasMultipleRepos && (
            <p className="pb-1 pt-4 text-sm font-semibold">
              <span>{repo.repoName}</span>
              <span> repo</span>
            </p>
          )}
          {repo.files.map((file) => (
            <FileNavEntry
              key={file.path}
              file={file}
              repoName={repo.repoName}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
