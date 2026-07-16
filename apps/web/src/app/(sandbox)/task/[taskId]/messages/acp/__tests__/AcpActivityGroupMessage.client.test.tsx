import { fireEvent, render, screen } from '@testing-library/react';

import { AcpActivityGroupMessage } from '../AcpActivityGroupMessage';
import type { AcpActivityGroupRenderBlock } from '../activity-groups';

function buildGroup(): AcpActivityGroupRenderBlock {
  return {
    kind: 'activity_group',
    id: 'activity-1',
    ts: 1_000,
    endTs: 18_000,
    blocks: [],
  };
}

describe('AcpActivityGroupMessage', () => {
  it('starts collapsed and expands to reveal activity details', () => {
    render(
      <AcpActivityGroupMessage
        group={buildGroup()}
        anchorIds={['activity-anchor']}
      >
        <div>Hidden activity</div>
      </AcpActivityGroupMessage>,
    );

    expect(
      screen.getByRole('button', { name: /Worked for 17s/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Hidden activity')).not.toBeInTheDocument();
    expect(document.getElementById('activity-anchor')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Worked for 17s/ }));

    expect(screen.getByText('Hidden activity')).toBeVisible();
  });
});
