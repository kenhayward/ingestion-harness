import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TemplatesPage } from '../src/templates/TemplatesPage.js';
import { fakeApi } from './fake-api.js';

const list = [
  {
    id: 'process-validation-protocol',
    name: 'Process Validation Protocol',
    description: null,
    published: 3,
    draft: null,
    versions: [{ version: 3, status: 'published' as const, updatedAt: '' }],
  },
  {
    id: 'letter',
    name: 'Letter',
    description: null,
    published: null,
    draft: 1,
    versions: [{ version: 1, status: 'draft' as const, updatedAt: '' }],
  },
];

describe('TemplatesPage', () => {
  it('lists document types with links to their published and draft versions', async () => {
    render(
      <TemplatesPage
        api={fakeApi({ listTemplates: vi.fn(async () => list) })}
        onNavigate={vi.fn()}
      />,
    );
    const row = await screen.findByRole('row', { name: /Process Validation Protocol/ });
    expect(within(row).getByRole('link', { name: 'v3 (published)' })).toHaveAttribute(
      'href',
      '#/templates/process-validation-protocol/3',
    );
    const letter = screen.getByRole('row', { name: /Letter/ });
    expect(within(letter).getByRole('link', { name: 'v1 (draft)' })).toHaveAttribute(
      'href',
      '#/templates/letter/1',
    );
  });

  it('creates a document type and opens its v1 draft', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({ listTemplates: vi.fn(async () => []) });
    render(<TemplatesPage api={api} onNavigate={onNavigate} />);
    await userEvent.type(await screen.findByLabelText('Id'), 'letter');
    await userEvent.type(screen.getByLabelText('Name'), 'Letter');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(api.createTemplate).toHaveBeenCalledWith('letter', 'Letter');
    expect(onNavigate).toHaveBeenCalledWith('#/templates/letter/1');
  });

  it('imports YAML, optionally publishing it', async () => {
    const onNavigate = vi.fn();
    const api = fakeApi({ listTemplates: vi.fn(async () => []) });
    render(<TemplatesPage api={api} onNavigate={onNavigate} />);
    await userEvent.type(await screen.findByLabelText('Template YAML'), 'id: memo');
    await userEvent.click(screen.getByLabelText('Publish if valid'));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(api.importTemplate).toHaveBeenCalledWith('id: memo', true);
    expect(onNavigate).toHaveBeenCalledWith('#/templates/memo/4');
  });
});
