import type { Block, Cell, DecomposedDocument, Equation, Inline, Section, Table } from './model.js';

// The comparison forms of a decomposed document: its text, unit by unit, and its table grids.
// This is the shared comparison code of the decomposition design (§7, §9), a port of the
// worker's decompose/forms.py. Both must reproduce the vectors in vectors/comparison-forms.json
// exactly; vectors/README.md states the forms.

/** NFC, every run of whitespace (no-break spaces and newlines included) as one space, trimmed. */
export function normalise(s: string): string {
  return s.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

const xrefToken = (targetId: string) => `⟦xref:${targetId}⟧`;
const equationToken = (value: string) => `⟦eq:${value}⟧`;
const noteToken = (noteId: string) => `⟦note:${noteId}⟧`;
const IMAGE_TOKEN = '⟦img⟧';

/** An image in the text form: its token, then its alt text if it has any. */
const imageText = (alt: string | null | undefined) => (alt ? `${IMAGE_TOKEN} ${alt}` : IMAGE_TOKEN);

/** Units as one: each normalised, the empty ones left out, joined by a space. */
const joinUnits = (units: string[]) =>
  units
    .map(normalise)
    .filter((u) => u)
    .join(' ');

class Forms {
  private readonly alts: Map<string, string | null>;
  private readonly equations: Map<string, Equation>;

  constructor(doc: DecomposedDocument) {
    this.alts = new Map(doc.images.map((i) => [i.id, i.alt]));
    this.equations = new Map(doc.equations.map((e) => [e.id, e]));
  }

  inlineText(inlines: Inline[]): string {
    return inlines.map((i) => this.inline(i)).join('');
  }

  inline(item: Inline): string {
    switch (item.kind) {
      case 'text':
        return item.text;
      case 'break':
        return ' ';
      case 'xref':
        return xrefToken(item.targetId);
      case 'link':
        return this.inlineText(item.inlines);
      case 'inline_equation':
        return this.equation(item.equationId);
      case 'inline_image':
        return imageText(this.alts.get(item.imageId));
      case 'note_ref':
        return noteToken(item.noteId);
    }
  }

  equation(equationId: string): string {
    const equation = this.equations.get(equationId);
    if (equation === undefined) return equationToken(equationId);
    if (equation.mathml !== null) return equationToken(equation.mathml);
    return equationToken(equation.imageId);
  }

  /** The raw (not yet normalised) units of a block. */
  blockUnits(block: Block): string[] {
    switch (block.kind) {
      case 'paragraph':
        return [this.inlineText(block.inlines)];
      case 'list':
        return block.items.flatMap((item) => item.blocks.flatMap((b) => this.blockUnits(b)));
      case 'table':
        return [
          this.inlineText(block.caption),
          ...block.rows.flatMap((row) => row.cells.map((cell) => this.cellText(cell))),
          ...block.notes.map((note) => `${note.marker}: ${this.inlineText(note.inlines)}`),
        ];
      case 'figure':
        return [this.inlineText(block.caption), imageText(this.alts.get(block.imageId))];
      case 'image':
        return [imageText(this.alts.get(block.imageId))];
      case 'equation':
        return [this.equation(block.equationId)];
    }
  }

  cellText(cell: Cell): string {
    return joinUnits(cell.blocks.flatMap((b) => this.blockUnits(b)));
  }

  textForm(doc: DecomposedDocument): string[] {
    const units: string[] = [];
    const add = (raw: string[]) => {
      for (const u of raw.map(normalise)) if (u) units.push(u);
    };
    const section = (s: Section) => {
      add([this.inlineText(s.title)]);
      for (const block of s.blocks) add(this.blockUnits(block));
      for (const sub of s.sections) section(sub);
    };
    for (const block of doc.blocks) add(this.blockUnits(block));
    for (const s of doc.sections) section(s);
    for (const note of doc.notes) for (const block of note.blocks) add(this.blockUnits(block));
    return units;
  }

  grid(table: Table): string[][] {
    const covered = new Map<string, string>();
    let rows = table.rows.length;
    let width = 0;
    table.rows.forEach((row, r) => {
      let c = 0;
      for (const cell of row.cells) {
        while (covered.has(`${r},${c}`)) c += 1;
        const slot = `${r},${c}|${normalise(this.cellText(cell))}`;
        const rowSpan = Math.max(cell.rowSpan, 1);
        const colSpan = Math.max(cell.colSpan, 1);
        for (let dr = 0; dr < rowSpan; dr += 1) {
          for (let dc = 0; dc < colSpan; dc += 1) {
            const key = `${r + dr},${c + dc}`;
            if (!covered.has(key)) covered.set(key, slot);
          }
        }
        rows = Math.max(rows, r + rowSpan);
        width = Math.max(width, c + colSpan);
        c += colSpan;
      }
    });
    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: width }, (_, c) => covered.get(`${r},${c}`) ?? ''),
    );
  }
}

/** Every table of the document, nested ones included, in the order of the text form. */
function tablesOf(doc: DecomposedDocument): Table[] {
  const found: Table[] = [];
  const blocks = (items: Block[]) => {
    for (const block of items) {
      if (block.kind === 'table') {
        found.push(block);
        for (const row of block.rows) for (const cell of row.cells) blocks(cell.blocks);
      } else if (block.kind === 'list') {
        for (const item of block.items) blocks(item.blocks);
      }
    }
  };
  const section = (s: Section) => {
    blocks(s.blocks);
    for (const sub of s.sections) section(sub);
  };
  blocks(doc.blocks);
  for (const s of doc.sections) section(s);
  for (const note of doc.notes) blocks(note.blocks);
  return found;
}

/** The document's text units, normalised, in document order. */
export function textForm(doc: DecomposedDocument): string[] {
  return new Forms(doc).textForm(doc);
}

/** Per table id, the table's grid as `"r,c|text"` slots. */
export function gridForms(doc: DecomposedDocument): Record<string, string[][]> {
  const forms = new Forms(doc);
  return Object.fromEntries(tablesOf(doc).map((t) => [t.id, forms.grid(t)]));
}
