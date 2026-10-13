/**
 * Object key conventions for SeaweedFS / S3. Mirrored in worker/src/ingest_worker/storage.py.
 *
 *   inbox bucket:   {specId}/v{version}/{documentId}.pdf
 *   outputs bucket: {specId}/v{version}/{outputId}/{documentId}.{csv|json}
 *   runs bucket:    {jobId}/{extractionId}/attempt-{n}.json   (prompt + raw response audit)
 *   runs bucket:    prepared/{sha256}/text.json | triage.json   (workbench prepare task)
 *   runs bucket:    segmentation/{projectId}/{jobId}.json   (workbench segment task)
 *   runs bucket:    drafting/{projectId}/{jobId}.json   (workbench draft task)
 */
export function inboxKey(specId: string, version: number, documentId: string): string {
  return `${specId}/v${version}/${documentId}.pdf`;
}

export function outputKey(
  specId: string,
  version: number,
  outputId: string,
  documentId: string,
  format: 'csv' | 'json',
): string {
  return `${specId}/v${version}/${outputId}/${documentId}.${format}`;
}

/** JPEG preview of a 1-based page for the review screen (runs bucket). */
export function pagePreviewKey(jobId: string, pageNumber: number): string {
  return `${jobId}/pages/page-${pageNumber}.jpg`;
}

/** Page text of a PDF after extraction + OCR (workbench prepare task, runs bucket). */
export function preparedTextKey(sha256: string): string {
  return `prepared/${sha256}/text.json`;
}

/** Page count, OCR'd pages and size of a prepared PDF (runs bucket). */
export function preparedTriageKey(sha256: string): string {
  return `prepared/${sha256}/triage.json`;
}

/** Section-anchor preview grid of a workbench project (runs bucket, worker segment task). */
export function segmentationKey(projectId: string, jobId: string): string {
  return `segmentation/${projectId}/${jobId}.json`;
}

/** A drafting stage's result for a workbench project (runs bucket, worker draft task). */
export function draftingKey(projectId: string, jobId: string): string {
  return `drafting/${projectId}/${jobId}.json`;
}

/** A project's exported drafting bundle (runs bucket, export task). */
export function exportKey(projectId: string, jobId: string): string {
  return `exports/${projectId}/${jobId}.zip`;
}
