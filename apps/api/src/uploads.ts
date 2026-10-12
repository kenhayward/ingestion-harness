import type { MultipartFile } from '@fastify/multipart';

const PDF_MAGIC = Buffer.from('%PDF-');

export function isPdf(body: Buffer): boolean {
  return body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

/** A text field sent before the file part. */
export function multipartField(file: MultipartFile, name: string): string | undefined {
  const f = file.fields[name];
  const one = Array.isArray(f) ? f[0] : f;
  return one && one.type === 'field' ? String(one.value) : undefined;
}
