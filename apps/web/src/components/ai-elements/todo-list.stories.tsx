import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import {
  TodoList,
  TodoListItem,
  TodoListItemContent,
  TodoListItemIndicator,
  TodoListItems,
  TodoListSection,
  TodoListSectionContent,
  TodoListSectionLabel,
  TodoListSectionTrigger,
} from './todo-list';

const meta: Meta = {
  title: 'Patterns/AI Elements/Conversation/TodoList',
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl border rounded-lg bg-background">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <TodoList>
      <TodoListSection>
        <TodoListSectionTrigger>
          <TodoListSectionLabel count={5} label="tasks remaining" />
        </TodoListSectionTrigger>
        <TodoListSectionContent>
          <TodoListItems>
            <TodoListItem completed>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator completed />
                <TodoListItemContent>
                  Set up project structure
                </TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem completed>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator completed />
                <TodoListItemContent>Install dependencies</TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem inProgress>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator inProgress />
                <TodoListItemContent>
                  Implement authentication module
                </TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator />
                <TodoListItemContent>Write unit tests</TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator />
                <TodoListItemContent>Deploy to staging</TodoListItemContent>
              </span>
            </TodoListItem>
          </TodoListItems>
        </TodoListSectionContent>
      </TodoListSection>
    </TodoList>
  ),
};

export const AllCompleted: Story = {
  render: () => (
    <TodoList>
      <TodoListSection allCompleted>
        <TodoListSectionTrigger>
          <TodoListSectionLabel count={3} label="tasks completed" />
        </TodoListSectionTrigger>
        <TodoListSectionContent>
          <TodoListItems>
            <TodoListItem completed>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator completed />
                <TodoListItemContent>Analyze requirements</TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem completed>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator completed />
                <TodoListItemContent>Design architecture</TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem completed>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator completed />
                <TodoListItemContent>Implement solution</TodoListItemContent>
              </span>
            </TodoListItem>
          </TodoListItems>
        </TodoListSectionContent>
      </TodoListSection>
    </TodoList>
  ),
};

export const InProgress: Story = {
  name: 'Mixed Progress',
  render: () => (
    <TodoList>
      <TodoListSection>
        <TodoListSectionTrigger>
          <TodoListSectionLabel count={4} label="steps" />
        </TodoListSectionTrigger>
        <TodoListSectionContent>
          <TodoListItems>
            <TodoListItem completed>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator completed />
                <TodoListItemContent>Read the codebase</TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem inProgress>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator inProgress />
                <TodoListItemContent>
                  Refactor the authentication service to use OAuth 2.0
                </TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator />
                <TodoListItemContent>
                  Update API documentation
                </TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator />
                <TodoListItemContent>Run integration tests</TodoListItemContent>
              </span>
            </TodoListItem>
          </TodoListItems>
        </TodoListSectionContent>
      </TodoListSection>
    </TodoList>
  ),
};

export const MultipleSections: Story = {
  render: () => (
    <TodoList>
      <TodoListSection allCompleted>
        <TodoListSectionTrigger>
          <TodoListSectionLabel count={2} label="completed" />
        </TodoListSectionTrigger>
        <TodoListSectionContent>
          <TodoListItems>
            <TodoListItem completed>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator completed />
                <TodoListItemContent>Parse input data</TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem completed>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator completed />
                <TodoListItemContent>Validate schema</TodoListItemContent>
              </span>
            </TodoListItem>
          </TodoListItems>
        </TodoListSectionContent>
      </TodoListSection>
      <TodoListSection>
        <TodoListSectionTrigger>
          <TodoListSectionLabel count={3} label="remaining" />
        </TodoListSectionTrigger>
        <TodoListSectionContent>
          <TodoListItems>
            <TodoListItem inProgress>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator inProgress />
                <TodoListItemContent>Transform data</TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator />
                <TodoListItemContent>Write to database</TodoListItemContent>
              </span>
            </TodoListItem>
            <TodoListItem>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator />
                <TodoListItemContent>Send notification</TodoListItemContent>
              </span>
            </TodoListItem>
          </TodoListItems>
        </TodoListSectionContent>
      </TodoListSection>
    </TodoList>
  ),
};

export const SingleItem: Story = {
  render: () => (
    <TodoList>
      <TodoListSection>
        <TodoListSectionTrigger>
          <TodoListSectionLabel count={1} label="task" />
        </TodoListSectionTrigger>
        <TodoListSectionContent>
          <TodoListItems>
            <TodoListItem inProgress>
              <span className="flex items-center gap-2">
                <TodoListItemIndicator inProgress />
                <TodoListItemContent>
                  Fix the null pointer exception in UserService.getProfile()
                </TodoListItemContent>
              </span>
            </TodoListItem>
          </TodoListItems>
        </TodoListSectionContent>
      </TodoListSection>
    </TodoList>
  ),
};

export const IndicatorStates: Story = {
  decorators: [
    (Story) => (
      <div className="w-full max-w-sm p-4 bg-background">
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-sm">
        <TodoListItemIndicator />
        <span className="text-muted-foreground">Pending</span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <TodoListItemIndicator inProgress />
        <span className="text-muted-foreground">In Progress</span>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <TodoListItemIndicator completed />
        <span className="text-muted-foreground">Completed</span>
      </div>
    </div>
  ),
};
