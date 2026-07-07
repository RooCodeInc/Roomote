type RepositoryEmptyState = {
  isEmpty?: boolean | null;
};

export function isRepositoryEmpty(repository: RepositoryEmptyState): boolean {
  return repository.isEmpty === true;
}

export function getEmptyRepositories<T extends RepositoryEmptyState>(
  repositories: T[],
): T[] {
  return repositories.filter(isRepositoryEmpty);
}

export function areAllRepositoriesEmpty(
  repositories: RepositoryEmptyState[],
): boolean {
  return repositories.length > 0 && repositories.every(isRepositoryEmpty);
}
