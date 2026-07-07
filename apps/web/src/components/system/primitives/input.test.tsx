import { fireEvent, render, screen } from '@testing-library/react';

import { Input } from './input';

describe('Input', () => {
  it('opts out of password-manager overlays by default', () => {
    render(<Input aria-label="Plain input" />);

    const input = screen.getByLabelText('Plain input');

    expect(input).toHaveAttribute('data-1p-ignore');
    expect(input).toHaveAttribute('data-op-ignore', 'true');
  });

  it('renders a built-in show and hide control for secret inputs', () => {
    render(<Input secret aria-label="API key" defaultValue="sk-test" />);

    const input = screen.getByLabelText('API key');

    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');

    fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
    expect(input).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'Hide value' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('keeps non-secret inputs unchanged', () => {
    render(<Input aria-label="Email" type="email" />);

    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(
      screen.queryByRole('button', { name: /show value|hide value/i }),
    ).not.toBeInTheDocument();
  });

  it('renders an inline password strength meter when enabled', () => {
    render(<Input secret passwordStrength aria-label="New password" />);

    const input = screen.getByLabelText('New password');
    const meter = screen.getByRole('meter', { name: 'Password strength' });

    expect(meter).toHaveAttribute('aria-valuenow', '0');

    fireEvent.change(input, {
      target: { value: 'correct horse battery staple' },
    });

    expect(meter).not.toHaveAttribute('aria-valuenow', '0');
  });

  it('does not render a password strength meter by default', () => {
    render(<Input secret aria-label="Password" />);

    expect(
      screen.queryByRole('meter', { name: 'Password strength' }),
    ).not.toBeInTheDocument();
  });

  it('renders a full-width weak meter state until the input matches', () => {
    render(
      <Input
        secret
        match="correct horse battery staple"
        aria-label="Confirm password"
      />,
    );

    const input = screen.getByLabelText('Confirm password');
    const meter = screen.getByRole('meter', { name: 'Input match' });
    const bar = meter.firstElementChild;

    fireEvent.change(input, {
      target: { value: 'correct horse battery' },
    });

    expect(meter).toHaveAttribute('aria-valuenow', '0');
    expect(bar).toHaveStyle({ width: '100%' });

    fireEvent.change(input, {
      target: { value: 'correct horse battery staple' },
    });

    expect(meter).toHaveAttribute('aria-valuenow', '4');
    expect(bar).toHaveStyle({ width: '100%' });
  });
});
