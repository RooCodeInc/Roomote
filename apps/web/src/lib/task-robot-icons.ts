export const TASK_ROBOT_ICON_COUNT = 100;

export type TaskRobotIconId = `robot-${string}`;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function getSessionPermutation(sessionId: string): number[] {
  const permutation = Array.from(
    { length: TASK_ROBOT_ICON_COUNT },
    (_, index) => index,
  );
  const random = seededRandom(hashString(sessionId));

  for (let index = permutation.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [permutation[index], permutation[swapIndex]] = [
      permutation[swapIndex]!,
      permutation[index]!,
    ];
  }

  return permutation;
}

function formatIconId(index: number): TaskRobotIconId {
  return `robot-${String(index + 1).padStart(3, '0')}`;
}

export function resolveTaskRobotIconId({
  taskId,
  sessionId,
  orderedTaskIds,
}: {
  taskId: string;
  sessionId?: string | null;
  orderedTaskIds?: readonly string[];
}): TaskRobotIconId {
  const canonicalSessionId = sessionId?.trim() || 'standalone';
  const permutation = getSessionPermutation(canonicalSessionId);
  const orderedIndex = orderedTaskIds
    ? [...new Set(orderedTaskIds)].indexOf(taskId)
    : -1;
  // Session task queries are ordered by attachment time and grow as a stable
  // prefix. The 101st task intentionally reuses the first seeded icon.
  const slot =
    orderedIndex >= 0
      ? orderedIndex % TASK_ROBOT_ICON_COUNT
      : // Lazy surfaces may learn about a task before the canonical list does.
        // This fallback is stable, but uniqueness begins once the list includes it.
        hashString(`${canonicalSessionId}:${taskId}`) % TASK_ROBOT_ICON_COUNT;

  return formatIconId(permutation[slot]!);
}

export function getTaskRobotIconPath(iconId: TaskRobotIconId): string {
  return `/task-robots/${iconId}.png`;
}
