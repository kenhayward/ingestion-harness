import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEV_VERSION } from '@ih/shared';
import { NavVersion, versionText } from '../src/shell/NavVersion.js';

const tagged = { version: '2026.10.17.3', previous: '2026.10.17.2', commit: 'abc1234' };

describe('NavVersion', () => {
  it('opens About and the release notes', async () => {
    const onOpen = vi.fn();
    render(<NavVersion info={tagged} compact={false} onOpen={onOpen} />);
    const button = screen.getByRole('button', {
      name: 'v2026.10.17.3: about CT Studio and release notes',
    });
    expect(button).toHaveTextContent('v2026.10.17.3');
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('names the version in the collapsed nav', () => {
    render(<NavVersion info={tagged} compact onOpen={vi.fn()} />);
    const button = screen.getByRole('button', {
      name: 'Version 2026.10.17.3: about CT Studio and release notes',
    });
    expect(button).toHaveAttribute('title', 'Version 2026.10.17.3');
    expect(button.querySelector('.nav-label')).toHaveTextContent('v2026.10.17.3');
  });

  it('opens About from a dev build too', () => {
    render(<NavVersion info={DEV_VERSION} compact={false} onOpen={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'dev: about CT Studio and release notes' }),
    ).toBeInTheDocument();
  });

  it.each([
    ['2026.10.17.3', 'v2026.10.17.3'],
    ['2026.10.17.2+abc1234', 'v2026.10.17.2+abc1234'],
    ['dev', 'dev'],
    ['dev+abc1234', 'dev+abc1234'],
  ])('writes %s as %s', (version, text) => {
    expect(versionText({ version, previous: null, commit: 'abc1234' })).toBe(text);
  });
});
