type LastActiveTask = {
  id: string;
  lastMessageAt: number;
};

export function sortTasksByLastActive<T extends LastActiveTask>(
  tasks: T[],
): T[] {
  return [...tasks].sort(
    (left, right) =>
      right.lastMessageAt - left.lastMessageAt ||
      right.id.localeCompare(left.id),
  );
}
