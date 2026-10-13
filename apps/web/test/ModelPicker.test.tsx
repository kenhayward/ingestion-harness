import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../src/ui/ModelPicker.js';
import { MODEL_CHOICES } from './fake-api.js';

const CHOICES = MODEL_CHOICES;

describe('ModelPicker', () => {
  it('offers the choices by label and shows the model the pick runs', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelPicker
        label="Model"
        choices={CHOICES}
        value=""
        onChange={onChange}
        emptyLabel="Template's models"
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Model' });
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      "Template's models",
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
        emptyLabel="Template's models"
      />,
    );
    expect(screen.getByText('cloud/claude')).toBeInTheDocument();
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
    expect(
      screen.getByRole('option', { name: 'local/qwen (not a model choice)' }),
    ).toBeInTheDocument();
  });

  it('reads `default` as the default choice', () => {
    render(<ModelPicker label="Model" choices={CHOICES} value="default" onChange={() => {}} />);
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe(
      'main',
    );
    expect(screen.getByText('local/qwen')).toBeInTheDocument();
  });
});
