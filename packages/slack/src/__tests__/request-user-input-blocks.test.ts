import {
  buildSlackAnsweredRequestUserInputBlocks,
  buildSlackRequestUserInputBlocks,
} from '../request-user-input-blocks';

describe('buildSlackRequestUserInputBlocks', () => {
  it('renders the current question in a followup-style layout', () => {
    const blocks = buildSlackRequestUserInputBlocks({
      requestId: 'rui:session:turn:call',
      currentQuestionIndex: 1,
      footerText:
        '_Reply with @-mention or use the <https://app.example.com/task/task-1|web app>._',
      answers: {
        stack: {
          answers: ['Blessed'],
        },
      },
      questions: [
        {
          id: 'stack',
          header: 'Stack',
          question: 'Which TUI stack should we use?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'Ink',
              description: 'React components.',
            },
            {
              label: 'Blessed',
              description: 'Manual terminal layout.',
            },
          ],
        },
        {
          id: 'layout',
          header: 'Layout',
          question: 'What should the UI optimize for?',
          isOther: true,
          isSecret: false,
          options: [
            {
              label: 'Dashboard (Recommended)',
              description: 'Pane-first interface.',
            },
          ],
        },
      ],
    });

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'markdown',
          text: 'What should the UI optimize for?',
        }),
        expect.objectContaining({
          type: 'section',
          text: expect.objectContaining({
            text: expect.stringContaining('*1. Dashboard*'),
          }),
          accessory: expect.objectContaining({
            text: expect.objectContaining({
              text: 'Pick',
            }),
            action_id: 'request_user_input_answer_0',
            value: JSON.stringify({
              requestId: 'rui:session:turn:call',
              questionId: 'layout',
              questionIndex: 1,
              answer: 'Dashboard (Recommended)',
            }),
          }),
        }),
        expect.objectContaining({
          type: 'context',
          elements: [
            expect.objectContaining({
              text: '_Reply with @-mention or use the <https://app.example.com/task/task-1|web app>._',
            }),
          ],
        }),
      ]),
    );

    expect(JSON.stringify(blocks)).not.toContain(
      'After this answer, I’ll send everything back to the agent.',
    );
    expect(JSON.stringify(blocks)).not.toContain(
      'After this answer, I’ll ask the next question.',
    );
    expect(JSON.stringify(blocks)).not.toContain('Question 2 of 2');
    expect(JSON.stringify(blocks)).not.toContain('Layout');
    expect(JSON.stringify(blocks)).not.toContain('Suggestions');
    expect(JSON.stringify(blocks)).not.toContain('Answered so far');
    expect(
      JSON.stringify(
        blocks.map((block) =>
          block.type === 'section' || block.type === 'markdown'
            ? block.text
            : null,
        ),
      ),
    ).not.toContain('(Recommended)');
    expect(JSON.stringify(blocks)).not.toContain('cancel to skip');
    expect(JSON.stringify(blocks)).not.toContain('Say `cancel`');
  });
});

describe('buildSlackAnsweredRequestUserInputBlocks', () => {
  it('renders the selected answer without interactive controls', () => {
    const blocks = buildSlackAnsweredRequestUserInputBlocks({
      question: {
        id: 'stack',
        header: 'Stack',
        question: 'Which stack should we use?',
        isOther: true,
        isSecret: false,
      },
      answer: 'Use Go instead',
    });

    expect(blocks).toEqual([
      {
        type: 'markdown',
        text: 'Which stack should we use?\n\n**Picked:** Use Go instead',
      },
    ]);
    expect(JSON.stringify(blocks)).not.toContain('button');
  });
});
