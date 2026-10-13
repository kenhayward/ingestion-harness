import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker, typeModelLabel } from '../src/ui/ModelPicker.js';
import { MODEL_CHOICES } from './fake-api.js';

const CHOICES = MODEL_CHOICES;

describe('ModelPicker', () => {
  it('offers the choices by label and flags an external pick', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelPicker
        label="Model"
        choices={CHOICES}
        value=""
        onChange={onChange}
        emptyLabel="Recipe's models"
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Model' });
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      "Recipe's models",
      'Main Production Model (default)',
      'Cloud model · external',
      'New for testing only',
    ]);
    await userEvent.selectOptions(select, 'New for testing only');
    expect(onChange).toHaveBeenCalledWith('test');

    rerender(
      <ModelPicker
        label="Model"
        choices={CHOICES}
        value="cloud"
        onChange={onChange}
        emptyLabel="Recipe's models"
      />,
    );
    expect(screen.queryByText(/cloud\/claude/)).toBeNull();
    expect(screen.getByText('External')).toBeInTheDocument();
  });

  it('disables external choices for a local-only project', () => {
    render(
      <ModelPicker
        label="Model"
        choices={CHOICES}
        value=""
        onChange={() => {}}
        dataPolicy="local"
      />,
    );
    const option = screen.getByRole('option', { name: /Cloud model/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
    expect((screen.getByRole('option', { name: /Main/ }) as HTMLOptionElement).disabled).toBe(
      false,
    );
  });

  it('keeps showing a stored name that is no choice (a legacy model ref)', () => {
    render(<ModelPicker label="Model" choices={CHOICES} value="local/qwen" onChange={() => {}} />);
    const select = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(select.value).toBe('local/qwen');
    expect(screen.getByRole('option', { name: 'Model no longer offered' })).toBeInTheDocument();
    expect(screen.queryByText(/local\/qwen/)).toBeNull();
  });

  it('reads a stored `draft` as the drafting model', () => {
    render(<ModelPicker label="Model" choices={CHOICES} value="draft" onChange={() => {}} />);
    expect(screen.getByRole('option', { name: 'Drafting model' })).toBeInTheDocument();
  });

  it('reads `default` as the default choice', () => {
    render(<ModelPicker label="Model" choices={CHOICES} value="default" onChange={() => {}} />);
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(
      'main',
    );
    expect(screen.queryByText(/local\/qwen/)).toBeNull();
  });
});

describe('typeModelLabel (the "no override" option)', () => {
  it.each<[{ model?: string } | undefined, string]>([
    [{ model: 'test' }, "Document type's model (New for testing only)"],
    [{}, "Document type's model (Main Production Model)"], // none set: the default choice
    [{ model: 'gone' }, "Document type's model (Model no longer offered)"],
    [undefined, "Document type's model"], // the type is not known here
  ])('%o -> %s', (type, label) => {
    expect(typeModelLabel(CHOICES, type)).toBe(label);
  });
});
