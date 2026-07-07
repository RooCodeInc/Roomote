import type { AcpPlanTodo } from '@roomote/types';

export function getDisplayedTodoStatus(
  todo: AcpPlanTodo,
  index: number,
  todos: AcpPlanTodo[],
  shouldSuppressActiveStatus: boolean,
): AcpPlanTodo['status'] {
  if (shouldSuppressActiveStatus) {
    return todo.status === 'completed' ? 'completed' : 'pending';
  }

  if (todo.status !== 'pending') {
    return todo.status;
  }

  const hasExplicitInProgress = todos.some(
    (entry) => entry.status === 'in_progress',
  );

  if (hasExplicitInProgress) {
    return 'pending';
  }

  const hasStarted = todos.some((entry) => entry.status === 'completed');

  if (
    hasStarted &&
    index === todos.findIndex((entry) => entry.status === 'pending')
  ) {
    return 'in_progress';
  }

  return 'pending';
}

function getStartedTodo(todos: AcpPlanTodo[]): AcpPlanTodo | null {
  return todos.find((todo) => todo.status === 'in_progress') ?? null;
}

function hasUniqueTodoContent(content: string, todos: AcpPlanTodo[]): boolean {
  return todos.filter((todo) => todo.content === content).length === 1;
}

export function findStartedTodo(
  previousTodos: AcpPlanTodo[],
  nextTodos: AcpPlanTodo[],
): AcpPlanTodo | null {
  const nextActiveTodo = getStartedTodo(nextTodos);

  if (!nextActiveTodo) {
    return null;
  }

  const previousActiveTodo = getStartedTodo(previousTodos);

  if (!previousActiveTodo) {
    return nextActiveTodo;
  }

  if (previousActiveTodo.id === nextActiveTodo.id) {
    return null;
  }

  // Runtime plans often fall back to array-position ids, so treat a uniquely
  // matching active content value as the same logical todo across reindexing.
  if (
    previousActiveTodo.content === nextActiveTodo.content &&
    hasUniqueTodoContent(previousActiveTodo.content, previousTodos) &&
    hasUniqueTodoContent(nextActiveTodo.content, nextTodos)
  ) {
    return null;
  }

  return nextActiveTodo;
}
