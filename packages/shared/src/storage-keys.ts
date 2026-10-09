/**
 * Object key conventions for SeaweedFS / S3. Mirrored in worker/src/ingest_worker/storage.py.
 *
 *   inbox bucket:   {specId}/v{version}/{documentId}.pdf
 *   outputs bucket: {specId}/v{version}/{outputId}/{documentId}.{csv|json}
 *   runs bucket:    {jobId}/{extractionId}/attempt-{n}.json   (prompt + raw response audit)
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
