import { z } from 'zod';

/**
 * A step's model log: the runs of a recipe step that needed more than one attempt, and each
 * attempt the worker saved (`{job}/{step}/attempt-{n}.json` in the runs bucket, as
 * `pipeline._audit` writes them; chunked and repeated calls under `{step}.chunk-1`,
 * `{step}.occ-2`, a plugin's `{step}.ask-1`).
 */
export const RetriedRunSchema = z.object({
  jobId: z.string().uuid(),
  /** The document the job ran on. */
  fileName: z.string(),
  /** The recipe version the job ran. */
  version: z.number().int(),
  /** The step run: when it started, how many attempts it took, on which model. */
  startedAt: z.string(),
  attempts: z.number().int(),
  model: z.string().nullable(),
  status: z.enum(['succeeded', 'failed']),
  trigger: z.enum(['process', 'rerun']),
});
export type RetriedRun = z.infer<typeof RetriedRunSchema>;

export const RetriedRunsSchema = z.object({ runs: z.array(RetriedRunSchema) });
export type RetriedRuns = z.infer<typeof RetriedRunsSchema>;

/** How many retried runs the model log lists, newest first. */
export const MAX_RETRIED_RUNS = 10;

/** One attempt as the worker saved it (`extract.Attempt`). */
export const StepAttemptSchema = z.object({
  n: z.number().int(),
  prompt: z.string(),
  /** The model's raw reply. */
  response: z.string(),
  /** Why the reply was refused and the step asked again (empty: it was accepted). */
  errors: z.array(z.string()),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
});
export type StepAttempt = z.infer<typeof StepAttemptSchema>;

/** One model call of a step (a step makes several when chunked or reading a repeating section). */
export const StepCallSchema = z.object({
  /** `step`, `step.chunk-1`, `step.occ-2`, `step.ask-1`. */
  label: z.string(),
  attempts: z.array(StepAttemptSchema),
});
export type StepCall = z.infer<typeof StepCallSchema>;

export const StepAttemptsSchema = z.object({ calls: z.array(StepCallSchema) });
export type StepAttempts = z.infer<typeof StepAttemptsSchema>;
