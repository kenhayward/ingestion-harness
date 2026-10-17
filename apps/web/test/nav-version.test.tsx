import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEV_VERSION, REPO_URL } from '@ih/shared';
import { NavVersion } from '../src/shell/NavVersion.js';

const tagged = { version: '2026.10.17.3', previous: '2026.10.17.2', commit: 'abc1234' };

describe('NavVersion', () => {
  it('links a tagged build to its tag on GitHub', () => {
    render(<NavVersion info={tagged} compact={false} />);
    const link = screen.getByRole('link', { name: 'v2026.10.17.3 (opens in a new tab)' });
    expect(link).toHaveAttribute('href', `${REPO_URL}/releases/tag/2026.10.17.3`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveTextContent('v2026.10.17.3');
  });

  it('names the version in the collapsed nav', () => {
    render(<NavVersion info={tagged} compact />);
    const link = screen.getByRole('link', { name: 'Version 2026.10.17.3 (opens in a new tab)' });
    expect(link).toHaveAttribute('title', 'Version 2026.10.17.3');
    expect(link.querySelector('.nav-label')).toHaveTextContent('v2026.10.17.3');
  });

  it('links an untagged build to its commit', () => {
    render(
      <NavVersion
        info={{ version: '2026.10.17.2+abc1234', previous: '2026.10.17.2', commit: 'abc1234' }}
        compact={false}
      />,
    );
    expect(
      screen.getByRole('link', { name: 'v2026.10.17.2+abc1234 (opens in a new tab)' }),
    ).toHaveAttribute('href', `${REPO_URL}/compare/2026.10.17.2...abc1234`);
  });

  it.each([
    [DEV_VERSION, 'dev'],
    [{ version: 'dev+abc1234', previous: null, commit: 'abc1234' }, 'dev+abc1234'],
  ])('shows a dev build without a link', (info, text) => {
    render(<NavVersion info={info} compact={false} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
