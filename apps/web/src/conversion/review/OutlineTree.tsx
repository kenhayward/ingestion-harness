import type { Section } from '@ih/bridge-contract';
import { Icon } from '../../ui/Icon.js';
import { innerBlocks } from './pages.js';
import { plainText } from './BlockView.js';

/** A section's heading as the outline and the document show it. */
export const headingOf = (section: Section) => plainText(section.title) || 'Untitled section';

/**
 * The heading outline of a held document as a tree: choosing a heading shows its first page and
 * brings its section into view. Each heading counts the flags on it and its own blocks.
 */
export function OutlineTree({
  sections,
  flagCount,
  selected,
  onShow,
}: {
  sections: readonly Section[];
  /** The flags on an element (a section or a block). */
  flagCount: (id: string) => number;
  selected: string | null;
  onShow: (id: string) => void;
}) {
  const blockIds = (blocks: Section['blocks']): string[] =>
    blocks.flatMap((b) => [b.id, ...blockIds(innerBlocks(b))]);
  const flagsUnder = (section: Section) =>
    [section.id, ...blockIds(section.blocks)].reduce((n, id) => n + flagCount(id), 0);
  const branch = (list: readonly Section[]) => (
    <ul>
      {list.map((section) => {
        const heading = headingOf(section);
        const flagged = flagsUnder(section);
        return (
          <li key={section.id}>
            <button
              type="button"
              className="outline-item"
              aria-label={`${heading}${flagged ? ` (${flagged} flagged)` : ''}`}
              aria-current={selected === section.id ? 'true' : undefined}
              title={heading}
              onClick={() => onShow(section.id)}
            >
              <span className="outline-name">
                <span>{heading}</span>
              </span>
              {flagged > 0 && (
                <span className="flag-chip" aria-hidden="true">
                  <Icon name="flag" />
                  {flagged}
                </span>
              )}
            </button>
            {section.sections.length > 0 && branch(section.sections)}
          </li>
        );
      })}
    </ul>
  );
  return (
    <nav className="conversion-outline" aria-label="Outline">
      <p className="outline-head" aria-hidden="true">
        <span>Headings</span>
      </p>
      {sections.length ? branch(sections) : <p className="muted">No headings.</p>}
    </nav>
  );
}
