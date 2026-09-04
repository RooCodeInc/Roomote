import { render } from '@testing-library/react';

const avatarSpy = vi.fn();

vi.mock('@/components/system', () => ({
  Avatar: (props: Record<string, unknown>) => {
    avatarSpy(props);
    return <div data-task-robot-icon={props['data-task-robot-icon']} />;
  },
}));

import { TaskRobotIcon } from './TaskRobotIcon';

describe('TaskRobotIcon', () => {
  it('renders its assigned asset through the shared small Avatar', () => {
    render(<TaskRobotIcon taskId="task-1" />);

    expect(avatarSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: expect.stringMatching(/^\/task-robots\/robot-\d{3}\.png$/),
        size: 'sm',
        alt: '',
      }),
    );
  });
});
