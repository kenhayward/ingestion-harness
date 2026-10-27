import { Fragment, type ReactNode } from 'react';
import type { Block, Cell, Flag, Inline, Table } from '@ih/bridge-contract';
import { Icon } from '../../ui/Icon.js';

/** What drawing the decomposed document needs beyond the blocks themselves. */
export interface DocumentView {
  /** A held image's URL by its id (null: not among the held images). */
  imageUrl: (imageId: string) => string | null;
  /** A held image's alt text, if it has one. */
  imageAlt: (imageId: string) => string | null;
  equation: (equationId: string) => { latex: string | null; imageId: string } | null;
  /** A footnote's number (1-based), by its id. */
  noteNumber: (noteId: string) => number | null;
  /** The flags on an element. */
  flagsOn: (id: string) => readonly Flag[];
  /** The element's first page (null: nothing places it). */
  firstPage: (id: string) => number | null;
  /** Shows the element's first page beside the document. */
  onShow: (id: string) => void;
  /** The element last chosen. */
  selected: string | null;
}

/** The plain text of some inlines (an image's alt, a section's outline entry). */
export function plainText(inlines: readonly Inline[]): string {
  return inlines
    .map((i) =>
      i.kind === 'text' || i.kind === 'xref'
        ? i.text
        : i.kind === 'link'
          ? plainText(i.inlines)
          : i.kind === 'break'
            ? ' '
            : '',
    )
    .join('')
    .trim();
}

const SAFE_HREF = /^(https?:|mailto:)/i;

const MARK_TAGS = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  superscript: 'sup',
  subscript: 'sub',
} as const;

export function Inlines({ inlines, view }: { inlines: readonly Inline[]; view: DocumentView }) {
  return <>{inlines.map((inline, i) => inlineNode(inline, i, view))}</>;
}

function inlineNode(inline: Inline, key: number, view: DocumentView): ReactNode {
  switch (inline.kind) {
    case 'text':
      return (
        <Fragment key={key}>
          {inline.marks.reduce<ReactNode>((node, mark) => {
            const Tag = MARK_TAGS[mark];
            return <Tag>{node}</Tag>;
          }, inline.text)}
        </Fragment>
      );
    case 'note_ref':
      return (
        <sup key={key} className="dd-note-ref">
          [{view.noteNumber(inline.noteId) ?? '?'}]
        </sup>
      );
    case 'xref':
      return (
        <span key={key} className="dd-xref">
          {inline.text}
        </span>
      );
    case 'link':
      // Only web and mail links open: the document is read, never trusted to run anything.
      return SAFE_HREF.test(inline.href) ? (
        <a key={key} href={inline.href} target="_blank" rel="noopener noreferrer">
          <Inlines inlines={inline.inlines} view={view} />
        </a>
      ) : (
        <span key={key} className="dd-xref" title={inline.href}>
          <Inlines inlines={inline.inlines} view={view} />
        </span>
      );
    case 'inline_equation':
      return <EquationView key={key} equationId={inline.equationId} view={view} inline />;
    case 'inline_image': {
      const src = view.imageUrl(inline.imageId);
      return src ? (
        <img
          key={key}
          className="dd-inline-image"
          src={src}
          alt={view.imageAlt(inline.imageId) ?? ''}
        />
      ) : null;
    }
    case 'break':
      return <br key={key} />;
  }
}

function EquationView({
  equationId,
  view,
  inline = false,
}: {
  equationId: string;
  view: DocumentView;
  inline?: boolean;
}) {
  const equation = view.equation(equationId);
  const src = equation ? view.imageUrl(equation.imageId) : null;
  const alt = equation?.latex ?? 'Equation';
  if (src)
    return <img className={inline ? 'dd-inline-image' : 'dd-equation'} src={src} alt={alt} />;
  return <code>{alt}</code>;
}

/** The flags on an element, each a button that shows the element's page. */
export function FlagList({ id, view }: { id: string | null; view: DocumentView }) {
  const flags = id === null ? [] : view.flagsOn(id);
  if (!flags.length) return null;
  return <Flags flags={flags} onShow={id === null ? undefined : () => view.onShow(id)} />;
}

export function Flags({ flags, onShow }: { flags: readonly Flag[]; onShow?: () => void }) {
  return (
    <ul className="dd-flags">
      {flags.map((flag, i) => (
        <li key={i}>
          <button
            type="button"
            className="dd-flag"
            aria-label={`${flag.code}: ${flag.message}`}
            disabled={!onShow}
            onClick={onShow}
          >
            <span className="flag-chip">
              <Icon name="flag" />
              <span className="mono">{flag.code}</span>
            </span>
            <span>{flag.message}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A section's or block's first page, as a button that shows it. */
export function PageButton({ id, view }: { id: string; view: DocumentView }) {
  const page = view.firstPage(id);
  if (page === null) return null;
  return (
    <button
      type="button"
      className="link dd-page"
      aria-label={`Show page ${page}`}
      title={`Show page ${page}`}
      onClick={() => view.onShow(id)}
    >
      p. {page}
    </button>
  );
}

/**
 * One block of a section as it would be delivered, with its page and its flags beside it. Blocks
 * inside a list or a table cell are drawn plainly (`nested`), with only their flags.
 */
export function BlockView({
  block,
  view,
  nested = false,
}: {
  block: Block;
  view: DocumentView;
  nested?: boolean;
}) {
  const body = blockBody(block, view);
  if (nested) {
    return (
      <>
        {body}
        <FlagList id={block.id} view={view} />
      </>
    );
  }
  return (
    <div
      id={`dd-${block.id}`}
      className={`dd-block${view.selected === block.id ? ' selected' : ''}`}
    >
      <div className="dd-block-body">{body}</div>
      <PageButton id={block.id} view={view} />
      <FlagList id={block.id} view={view} />
    </div>
  );
}

function blockBody(block: Block, view: DocumentView): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p>
          <Inlines inlines={block.inlines} view={view} />
        </p>
      );
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List>
          {block.items.map((item, i) => (
            <li key={i}>
              {item.blocks.map((b) => (
                <BlockView key={b.id} block={b} view={view} nested />
              ))}
            </li>
          ))}
        </List>
      );
    }
    case 'table':
      return <TableView table={block} view={view} />;
    case 'figure': {
      const caption = (
        <figcaption>
          <Inlines inlines={block.caption} view={view} />
        </figcaption>
      );
      return (
        <figure className="dd-figure">
          {block.captionPosition === 'above' && caption}
          <Crop imageId={block.imageId} alt={plainText(block.caption)} view={view} />
          {block.captionPosition === 'below' && caption}
        </figure>
      );
    }
    case 'equation':
      return <EquationView equationId={block.equationId} view={view} />;
    case 'image':
      return <Crop imageId={block.imageId} alt="" view={view} />;
  }
}

function Crop({ imageId, alt, view }: { imageId: string; alt: string; view: DocumentView }) {
  const src = view.imageUrl(imageId);
  if (!src) return <p className="muted">The image {imageId} is not among the held images.</p>;
  return <img className="dd-crop" src={src} alt={view.imageAlt(imageId) ?? alt} />;
}

/** A table as its grid: header rows and header cells as `th`, merges as their spans. */
function TableView({ table, view }: { table: Table; view: DocumentView }) {
  const cellNode = (cell: Cell, header: boolean, key: number) => {
    const Tag = header || cell.header ? 'th' : 'td';
    return (
      <Tag
        key={key}
        {...(cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {})}
        {...(cell.colSpan > 1 ? { colSpan: cell.colSpan } : {})}
        style={{ textAlign: cell.hAlign, verticalAlign: cell.vAlign }}
      >
        {cell.blocks.map((b) => (
          <BlockView key={b.id} block={b} view={view} nested />
        ))}
      </Tag>
    );
  };
  return (
    <div className="dd-table">
      <table>
        {table.caption.length > 0 && (
          <caption className={table.captionPosition === 'below' ? 'below' : undefined}>
            <Inlines inlines={table.caption} view={view} />
          </caption>
        )}
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>{row.cells.map((cell, c) => cellNode(cell, r < table.headerRows, c))}</tr>
          ))}
        </tbody>
      </table>
      {table.notes.length > 0 && (
        <dl className="dd-table-notes">
          {table.notes.map((note, i) => (
            <div key={i}>
              <dt>{note.marker}</dt>
              <dd>
                <Inlines inlines={note.inlines} view={view} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
