/**
 * Object key conventions for SeaweedFS / S3. Mirrored in worker/src/ingest_worker/storage.py.
 *
 *   inbox bucket:   {specId}/v{version}/{documentId}.{pdf|docx}   (the kind judged from the bytes)
 *   outputs bucket: {specId}/v{version}/{outputId}/{documentId}.{csv|json}
 *   runs bucket:    {jobId}/{extractionId}/attempt-{n}.json   (prompt + raw response audit)
 *   runs bucket:    prepared/{sha256}/text.json | triage.json   (workbench prepare task)
 *   runs bucket:    segmentation/{projectId}/{jobId}.json   (workbench segment task)
 *   runs bucket:    drafting/{projectId}/{jobId}.json   (workbench draft task)
 *   runs bucket:    {jobId}/draft-log.json   (a draft job's model log: prompts, replies, tools)
 *   runs bucket:    ontologies/{ontologyId}/sources/{sha256}.{ext}   (imported ontology files)
 *   runs bucket:    ontologies/{ontologyId}/v{version}/normalized.nt   (ontology task)
 *   runs bucket:    decompositions/{batchId}/{itemId}.{ext}   (a batch item's uploaded file)
 *   runs bucket:    decompositions/{batchId}/{itemId}.report.json   (decompose task)
 *   runs bucket:    decompositions/{batchId}/{itemId}.held/...   (a PDF held for review)
 */
export function inboxKey(
  specId: string,
  version: number,
  documentId: string,
  ext: 'pdf' | 'docx' = 'pdf',
): string {
  return `${specId}/v${version}/${documentId}.${ext}`;
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The content type of an uploaded source, from its inbox key: the API names the object after
 * the kind it judged from the bytes (docs/design/word-documents.md), and every document row
 * copied from it (sample test runs, regression runs) shares the key.
 */
export function sourceContentType(objectKey: string): 'application/pdf' | typeof DOCX_MIME {
  return objectKey.endsWith('.docx') ? DOCX_MIME : 'application/pdf';
}

export function outputKey(
  specId: string,
  version: number,
  outputId: string,
  documentId: string,
  /** The file extension: `ttl` for a graph (`outputExtension`). */
  format: 'csv' | 'json' | 'ttl',
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

/** A reviewed job's approved document (edits applied), runs bucket; `storage.reviewed_document_key`. */
export function reviewedDocumentKey(jobId: string): string {
  return `${jobId}/reviewed-document.json`;
}

/** A job's SHACL report of its document's graph (runs bucket; `storage.shacl_report_key`). */
export function shaclReportKey(jobId: string): string {
  return `${jobId}/shacl-report.json`;
}

/** A graph preview's Turtle per sample (runs bucket, worker graph task; ADR 0011). */
export function graphPreviewKey(projectId: string, jobId: string): string {
  return `graphs/${projectId}/${jobId}.json`;
}

/** A plugin step preview's result per sample (runs bucket; worker `plugin_preview_key`). */
export function pluginPreviewKey(projectId: string, jobId: string): string {
  return `plugin-previews/${projectId}/${jobId}.json`;
}

/** A survey's or refresh's ontology suggestions (runs bucket, worker draft/suggest tasks). */
export function ontologySuggestionsKey(projectId: string, jobId: string): string {
  return `ontology-suggestions/${projectId}/${jobId}.json`;
}

/** A drafting stage's result for a workbench project (runs bucket, worker draft task). */
export function draftingKey(projectId: string, jobId: string): string {
  return `drafting/${projectId}/${jobId}.json`;
}

/** A drafting job's model log (runs bucket; worker `draft_log_key`, `DraftLogSchema`). */
export function draftLogKey(jobId: string): string {
  return `${jobId}/draft-log.json`;
}

/** A drafting run's audit of one model call, from before the model log (runs bucket). */
export function runAttemptKey(jobId: string, label: string, attempt: number): string {
  return `${jobId}/${label}/attempt-${attempt}.json`;
}

/** A project's exported drafting bundle (runs bucket, export task). */
export function exportKey(projectId: string, jobId: string): string {
  return `exports/${projectId}/${jobId}.zip`;
}

/** An imported ontology file, named by its bytes (runs bucket; ADR 0011). */
export function ontologySourceKey(ontologyId: string, sha256: string, ext: string): string {
  return `ontologies/${ontologyId}/sources/${sha256}.${ext}`;
}

/** A version's canonical N-Triples (runs bucket, ontology task). */
export function ontologyNormalizedKey(ontologyId: string, version: number): string {
  return `ontologies/${ontologyId}/v${version}/normalized.nt`;
}

/** Everything a conversion batch stores (runs bucket): its items' files, reports and held PDFs. */
export function decompositionBatchPrefix(batchId: string): string {
  return `decompositions/${batchId}/`;
}

/** A batch item's uploaded Word file (runs bucket; phase 3 conversion batches). */
export function decompositionSourceKey(batchId: string, itemId: string, ext: string): string {
  return `decompositions/${batchId}/${itemId}.${ext}`;
}

/** A batch item's decomposition report flags (runs bucket, decompose task). */
export function decompositionReportKey(batchId: string, itemId: string): string {
  return `decompositions/${batchId}/${itemId}.report.json`;
}

/** A held PDF's manifest (runs bucket): the converted document waiting for review. */
export function decompositionHeldManifestKey(batchId: string, itemId: string): string {
  return `decompositions/${batchId}/${itemId}.held/manifest.json`;
}

/** One of a held PDF's extracted images (runs bucket). */
export function decompositionHeldImageKey(batchId: string, itemId: string, index: number): string {
  return `decompositions/${batchId}/${itemId}.held/images/${index}`;
}

/** One of a held PDF's rendered pages (runs bucket). */
export function decompositionHeldPageKey(batchId: string, itemId: string, page: number): string {
  return `decompositions/${batchId}/${itemId}.held/pages/${page}.jpg`;
}
