import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TermLabel } from '@ih/shared';
import { TermInfo, termHref } from '../src/ui/TermInfo.js';

const IRI = 'http://purl.allotrope.org/ontologies/property#AFX_0000690';
const info = (over: Partial<TermLabel> = {}): TermLabel => ({
  from: 'ontology',
  iri: IRI,
  label: 'has value',
  kind: 'datatype_property',
  ontology: 'afo@1',
  deprecated: false,
  altLabels: ['value'],
  definition: 'The literal piece of information as part of some information entity object.',
  ...over,
});

describe('TermInfo', () => {
  it('shows what a term means: its name, synonyms, definition and where it is from', () => {
    render(<TermInfo info={info()} />);
    expect(screen.getByText('has value')).toBeInTheDocument();
    expect(screen.getByText('Also called: value')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The literal piece of information as part of some information entity object.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Ontologies' })).toHaveAttribute(
      'href',
      termHref('afo@1', IRI),
    );
  });

  it('folds a long definition behind More', async () => {
    const long = 'A long definition. '.repeat(20).trim();
    render(<TermInfo info={info({ definition: long })} />);
    const more = screen.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(screen.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('says so when a term has no definition, and links a local term nowhere', () => {
    render(
      <TermInfo
        info={info({
          from: 'local',
          ontology: null,
          altLabels: [],
          definition: null,
          label: 'Mine',
        })}
      />,
    );
    expect(screen.getByText('No definition')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/Also called/)).toBeNull();
  });

  it('builds the ontology browser link at the version that holds the term', () => {
    expect(termHref('afo@3', IRI)).toBe(
      '#/ontologies/afo/3/http%3A%2F%2Fpurl.allotrope.org%2Fontologies%2Fproperty%23AFX_0000690',
    );
  });
});
