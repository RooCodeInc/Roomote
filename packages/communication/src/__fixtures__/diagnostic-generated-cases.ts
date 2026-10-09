// Synthetic test inputs only; shared by helper and packaged-hook comparisons.
export const diagnosticProbes = [
  'synthetic-alpha',
  'synthetic-beta',
  'synthetic-gamma',
];

export function generatedDiagnosticTextCases() {
  const cases: { label: string; input: string }[] = [];
  for (const label of [
    'tokenCount',
    'TOKENCOUNT',
    'token_count',
    'TOKEN-COUNT',
    'token.count',
    'clientTokenCount',
    'passwordHint',
    'api_key',
    'authorization',
    'custom_setting',
    'pm_id',
    'status',
    'exec_mode',
    'key',
    'hmacKey',
  ])
    for (const separator of [':', '='])
      for (const labelQuote of ['', '"', "'"])
        for (const valueQuote of ['', '"', "'"])
          for (const padding of [' ', '\t'])
            for (const ending of ['\n', '\r\n'])
              for (const multiple of [false, true])
                for (const long of [false, true]) {
                  const value = diagnosticProbes.join(' ');
                  cases.push({
                    label,
                    input: `diag ${labelQuote}${label}${labelQuote}${padding}${separator}${padding}${valueQuote}${long ? `${value} `.repeat(500) : value}${valueQuote}${multiple ? ', password: secondary-fixture' : ''}${ending}status: online`,
                  });
                }
  return cases;
}

export function generatedRelatedExceptionCases() {
  const cases: {
    category: string;
    input: unknown;
    secretValues?: string[];
  }[] = [];
  const value = diagnosticProbes.join(' ');
  for (const key of [
    'tokenCount',
    'TOKENCOUNT',
    'token_count',
    'TOKEN-COUNT',
    'token.count',
  ])
    for (const item of [42, null, true, value, 'n'.repeat(20_000), { id: 1 }])
      cases.push({ category: 'structured-count', input: { [key]: item } });
  for (const key of [
    'pm_id',
    'restart_time',
    'unstable_restarts',
    'created_at',
    'pm_uptime',
    'exit_code',
    'instances',
  ])
    for (const item of [42, 0, -1, null, true, value, NaN, Infinity])
      cases.push({
        category: 'pm2-numeric',
        input: { pm2_env: { [key]: item } },
      });
  for (const item of [
    'online',
    'stopped',
    'stopping',
    'errored',
    'launching',
    'waiting restart',
    'one-launch-status',
    value,
    42,
    null,
    true,
  ])
    cases.push({
      category: 'pm2-status',
      input: { pm2_env: { status: item } },
    });
  for (const item of ['fork_mode', 'cluster_mode', value, 42, null, true])
    cases.push({
      category: 'pm2-mode',
      input: { pm2_env: { exec_mode: item } },
    });
  for (const key of [
    'env',
    'ENV',
    'environment',
    'ENVIRONMENT',
    'environmentVariables',
    'ENVIRONMENTVARIABLES',
    'environment_variables',
    'ENVIRONMENT_VARIABLES',
  ])
    for (const item of [
      null,
      42,
      true,
      value,
      [value],
      { custom_setting: value },
      { tokenCount: 42 },
    ])
      for (const placement of ['root', 'nested', 'pm2_env']) {
        const input = { [key]: item };
        cases.push({
          category: 'environment',
          input: placement === 'root' ? input : { [placement]: input },
        });
      }
  for (const item of [
    null,
    value,
    { custom_setting: value },
    { status: value },
  ])
    cases.push({ category: 'pm2-array', input: { pm2_env: [item] } });
  for (const alphabet of ['a', 'xY1/'])
    for (const length of [39, 40, 41, 47, 48, 49, 20_000])
      cases.push({
        category: 'opaque-text',
        input: `diag ${alphabet.repeat(length).slice(0, length)}`,
      });
  for (const length of [1, 7, 8, 32]) {
    const secret = 'q'.repeat(length);
    for (const input of [
      `diag ${secret}`,
      { output: `diag ${secret}` },
      JSON.stringify({ output: secret }),
    ])
      cases.push({
        category: 'known-value-length',
        input,
        secretValues: [secret],
      });
  }
  return cases;
}

export function generatedPm2ArrayCases() {
  const value = diagnosticProbes.join(' ');
  const elements: [unknown, unknown][] = [
    [
      {
        custom_setting: value,
        MixedSetting: value,
        status: 'online',
        restart_time: 3,
        pm_id: 0,
        exec_mode: 'fork_mode',
        env: { custom_setting: value },
      },
      {
        custom_setting: '[redacted]',
        MixedSetting: '[redacted]',
        status: 'online',
        restart_time: 3,
        pm_id: 0,
        exec_mode: 'fork_mode',
        env: { custom_setting: '[redacted]' },
      },
    ],
    [
      { pm_id: value, status: value, exec_mode: value },
      { pm_id: '[redacted]', status: '[redacted]', exec_mode: '[redacted]' },
    ],
    [value, '[redacted]'],
    [42, '[redacted]'],
    [null, '[redacted]'],
    [JSON.stringify({ custom_setting: value }), '[redacted]'],
  ];
  return elements.flatMap(([input, expected]) =>
    [
      { array: [input], expected: [expected] },
      { array: [[input]], expected: [[expected]] },
      { array: [input, [input]], expected: [expected, [expected]] },
    ].map(({ array, expected }) => ({
      input: {
        pm2_env: array,
        tokenCount: 42,
        output: 'n'.repeat(20_000),
        items: Array.from({ length: 80 }, (_, id) => id),
      },
      expectedPm2: expected,
    })),
  );
}
