import { z } from 'zod';

/** One setting of a target: fixed, or a pattern resolved per document. */
export const DestinationFieldSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['fixed', 'pattern']),
  required: z.boolean(),
  overridable: z.boolean(),
  browse: z.boolean(),
});
export type DestinationField = z.infer<typeof DestinationFieldSchema>;

export const CredentialSchema = z.record(z.string(), z.string());
