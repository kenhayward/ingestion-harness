import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { YamlEditor } from '../src/ui/YamlEditor.js';
import { setYaml } from './yaml-editor.js';

describe('YamlEditor', () => {
  it('shows the YAML in a labelled, multi-line editor', () => {
    render(
      <YamlEditor label="Recipe YAML" value={'id: letter\nname: Letter\n'} onChange={vi.fn()} />,
    );
    const box = screen.getByRole('textbox', { name: 'Recipe YAML' });
    expect(box).toHaveAttribute('aria-multiline', 'true');
    expect(box).toHaveTextContent('name: Letter');
  });

  it('colour-codes keys and values', () => {
    render(<YamlEditor label="Recipe YAML" value={'name: Letter\n# note\n'} onChange={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Recipe YAML' });
    // Highlighting is visual: the token classes are what the colour rules hang on.
    const token = (cls: string) => [...box.querySelectorAll(`.${cls}`)].map((e) => e.textContent);
    expect(token('tok-propertyName')).toContain('name');
    expect(token('tok-comment')).toContain('# note');
  });

  it('reports edits', () => {
    const onChange = vi.fn();
    render(<YamlEditor label="Recipe YAML" value="id: a" onChange={onChange} />);
    setYaml('Recipe YAML', 'id: b');
    expect(onChange).toHaveBeenLastCalledWith('id: b');
  });

  it('follows a new value from outside without reporting it as an edit', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <YamlEditor label="Recipe YAML" value="id: a" onChange={onChange} />,
    );
    rerender(<YamlEditor label="Recipe YAML" value="id: c" onChange={onChange} />);
    expect(screen.getByRole('textbox', { name: 'Recipe YAML' })).toHaveTextContent('id: c');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is read-only when asked', () => {
    render(<YamlEditor label="Recipe YAML" value="id: a" onChange={vi.fn()} readOnly />);
    const box = screen.getByRole('textbox', { name: 'Recipe YAML' });
    expect(box).toHaveAttribute('contenteditable', 'false');
    expect(box).toHaveAttribute('aria-readonly', 'true');
  });
});
