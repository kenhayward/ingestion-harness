import { z } from 'zod';

// The decomposed document: a checked, source-neutral tree of sections, blocks and inlines. It
// mirrors the worker's Pydantic models (worker/src/ingest_worker/decompose/model.py) field for
// field, in camelCase like the rest of the contract. Defaults are the models' defaults.

export const MarkSchema = z.enum(['bold', 'italic', 'underline', 'superscript', 'subscript']);
export type Mark = z.infer<typeof MarkSchema>;

export const FlagCodeSchema = z.enum([
  'changes_accepted',
  'symbol_unmapped',
  'heading_skipped_level',
  'heading_empty',
  'caption_not_found',
  'table_notes_unrecognised',
  'xref_unmatched',
  'image_floating_anchored',
  'image_converted',
  'drawing_rendered',
  'equation_image_only',
  'structure_inferred',
  'page_recognised',
]);
export type FlagCode = z.infer<typeof FlagCodeSchema>;

const CaptionPositionSchema = z.enum(['above', 'below']);

// --- Inlines ------------------------------------------------------------------------------

export interface TextInline {
  kind: 'text';
  text: string;
  marks: Mark[];
}
export interface NoteRefInline {
  kind: 'note_ref';
  noteId: string;
}
export interface XRefInline {
  kind: 'xref';
  targetId: string;
  text: string;
}
export interface LinkInline {
  kind: 'link';
  href: string;
  inlines: Inline[];
}
export interface InlineEquation {
  kind: 'inline_equation';
  equationId: string;
}
export interface InlineImage {
  kind: 'inline_image';
  imageId: string;
}
export interface BreakInline {
  kind: 'break';
}
export type Inline =
  TextInline | NoteRefInline | XRefInline | LinkInline | InlineEquation | InlineImage | BreakInline;

// The recursive members reach the unions through getters, so the unions are built lazily; the
// unions' explicit types break the type-level cycle.
export const InlineSchema: z.ZodType<Inline> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z.string(),
    marks: z.array(MarkSchema).default([]),
  }),
  z.strictObject({ kind: z.literal('note_ref'), noteId: z.string() }),
  z.strictObject({ kind: z.literal('xref'), targetId: z.string(), text: z.string() }),
  z.strictObject({
    kind: z.literal('link'),
    href: z.string(),
    get inlines() {
      return z.array(InlineSchema);
    },
  }),
  z.strictObject({ kind: z.literal('inline_equation'), equationId: z.string() }),
  z.strictObject({ kind: z.literal('inline_image'), imageId: z.string() }),
  z.strictObject({ kind: z.literal('break') }),
]);

// --- Blocks -------------------------------------------------------------------------------

export interface Paragraph {
  kind: 'paragraph';
  id: string;
  inlines: Inline[];
}
export interface ListItem {
  blocks: Block[];
}
export interface ListBlock {
  kind: 'list';
  id: string;
  ordered: boolean;
  items: ListItem[];
}
export interface Cell {
  rowSpan: number;
  colSpan: number;
  hAlign: 'left' | 'center' | 'right' | 'justify';
  vAlign: 'top' | 'middle' | 'bottom';
  header: boolean;
  blocks: Block[];
}
export interface Row {
  cells: Cell[];
}
export interface TableNote {
  marker: string;
  inlines: Inline[];
}
export interface Table {
  kind: 'table';
  id: string;
  numbered: boolean;
  caption: Inline[];
  captionPosition: 'above' | 'below';
  columnWidths: number[];
  headerRows: number;
  rows: Row[];
  notes: TableNote[];
  wide: boolean;
  key: string | null;
}
export interface Figure {
  kind: 'figure';
  id: string;
  imageId: string;
  numbered: boolean;
  caption: Inline[];
  captionPosition: 'above' | 'below';
}
export interface EquationBlock {
  kind: 'equation';
  id: string;
  equationId: string;
}
export interface ImageBlock {
  kind: 'image';
  id: string;
  imageId: string;
}
export type Block = Paragraph | ListBlock | Table | Figure | EquationBlock | ImageBlock;

const CellSchema = z.strictObject({
  rowSpan: z.number().int().default(1),
  colSpan: z.number().int().default(1),
  hAlign: z.enum(['left', 'center', 'right', 'justify']).default('left'),
  vAlign: z.enum(['top', 'middle', 'bottom']).default('top'),
  header: z.boolean().default(false),
  get blocks() {
    return z.array(BlockSchema);
  },
});

export const BlockSchema: z.ZodType<Block> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('paragraph'), id: z.string(), inlines: z.array(InlineSchema) }),
  z.strictObject({
    kind: z.literal('list'),
    id: z.string(),
    ordered: z.boolean(),
    get items() {
      return z.array(z.strictObject({ blocks: z.array(BlockSchema) }));
    },
  }),
  z.strictObject({
    kind: z.literal('table'),
    id: z.string(),
    numbered: z.boolean().default(false),
    caption: z.array(InlineSchema).default([]),
    captionPosition: CaptionPositionSchema.default('above'),
    columnWidths: z.array(z.number()),
    headerRows: z.number().int(),
    rows: z.array(z.strictObject({ cells: z.array(CellSchema) })),
    notes: z
      .array(z.strictObject({ marker: z.string(), inlines: z.array(InlineSchema) }))
      .default([]),
    wide: z.boolean().default(false),
    key: z.string().nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal('figure'),
    id: z.string(),
    imageId: z.string(),
    numbered: z.boolean(),
    caption: z.array(InlineSchema),
    captionPosition: CaptionPositionSchema,
  }),
  z.strictObject({ kind: z.literal('equation'), id: z.string(), equationId: z.string() }),
  z.strictObject({ kind: z.literal('image'), id: z.string(), imageId: z.string() }),
]);

// --- Document -----------------------------------------------------------------------------

export interface Section {
  id: string;
  title: Inline[];
  blocks: Block[];
  sections: Section[];
}

export const SectionSchema: z.ZodType<Section> = z.strictObject({
  id: z.string(),
  title: z.array(InlineSchema),
  blocks: z.array(BlockSchema),
  get sections() {
    return z.array(SectionSchema);
  },
});

export const DecomposedImageSchema = z.strictObject({
  id: z.string(),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']),
  widthMm: z.number(),
  heightMm: z.number(),
  align: z.enum(['left', 'center', 'right', 'inline']),
  alt: z.string().nullable().default(null),
  origin: z.enum(['embedded', 'converted', 'rendered', 'cropped']),
  originalContentType: z.string().nullable().default(null),
});
export type DecomposedImage = z.infer<typeof DecomposedImageSchema>;

export const EquationSchema = z.strictObject({
  id: z.string(),
  mathml: z.string().nullable().default(null),
  latex: z.string().nullable().default(null),
  imageId: z.string(),
});
export type Equation = z.infer<typeof EquationSchema>;

export const NoteSchema = z.strictObject({ id: z.string(), blocks: z.array(BlockSchema) });
export type Note = z.infer<typeof NoteSchema>;

export const PropertySchema = z.strictObject({
  name: z.string(),
  value: z.string(),
  origin: z.enum(['core', 'custom', 'header-field', 'pdf-info']),
});
export type Property = z.infer<typeof PropertySchema>;

export const FlagSchema = z.strictObject({
  code: FlagCodeSchema,
  severity: z.enum(['info', 'warning']),
  at: z.string().nullable().default(null),
  message: z.string(),
});
export type Flag = z.infer<typeof FlagSchema>;

export const DecomposedDocumentSchema = z.strictObject({
  blocks: z.array(BlockSchema),
  sections: z.array(SectionSchema),
  images: z.array(DecomposedImageSchema),
  equations: z.array(EquationSchema),
  notes: z.array(NoteSchema),
  properties: z.array(PropertySchema),
  report: z.array(FlagSchema),
});
export type DecomposedDocument = z.infer<typeof DecomposedDocumentSchema>;
