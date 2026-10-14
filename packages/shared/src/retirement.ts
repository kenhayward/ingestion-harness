import { z } from 'zod';

/**
 * A retired document type (migration 0030): hidden from new work (uploads, test runs, drafting,
 * publishing), every version still readable. Keyed by type id, so legacy spec.yaml types too.
 */
export const RetirementSchema = z.object({
  retiredAt: z.string().describe('When an admin retired the document type.'),
  retiredBy: z
    .string()
    .nullable()
    .describe('The label of the token that retired it; null without access control.'),
});
export type Retirement = z.infer<typeof RetirementSchema>;

/** The 409 every route that would start new work for a retired document type answers. */
export const retiredMessage = (title: string) => `${title} is retired: unretire it to use it again`;
