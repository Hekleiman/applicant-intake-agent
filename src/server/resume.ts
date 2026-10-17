import { extractText, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import { HttpError } from './http.js';

export const MAX_RESUME_BYTES = 2 * 1024 * 1024;
export const MAX_RESUME_CHARS = 20_000;

// Base64 is 4 characters per 3 bytes, so a 2 MB file is about 2.8 million characters and the JSON
// body stays under Vercel's 4.5 MB request limit. The schema allows a little more so a slightly
// larger file gets the plain "larger than 2 MB" message below instead of a schema error.
const MAX_BASE64_CHARS = 4_000_000;

export const ResumeUpload = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().max(100),
  base64: z.string().min(1).max(MAX_BASE64_CHARS),
});

export type ResumeUpload = z.infer<typeof ResumeUpload>;

const kindOf = (upload: ResumeUpload): 'pdf' | 'txt' | null => {
  const name = upload.filename.toLowerCase();
  const type = upload.contentType.toLowerCase();
  if (name.endsWith('.pdf') || type === 'application/pdf') return 'pdf';
  if (name.endsWith('.txt') || type === 'text/plain') return 'txt';
  return null;
};

// Collapses runs of spaces and tabs, trims each line and keeps at most one blank line in a row.
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// What extraction kept. truncated is true when the text was longer than 20,000 characters and
// only its start was kept; originalChars is the length before the cut. Both are measured here, on
// our server, never by a model.
export type ExtractedResume = { text: string; truncated: boolean; originalChars: number };

// Extracts the text of a PDF or .txt resume on our server. Only the text is kept: the file is
// never stored and never sent to a model. Refuses with a plain message what it can't use, and
// keeps at most the first 20,000 characters.
export async function extractResumeText(upload: ResumeUpload): Promise<ExtractedResume> {
  const kind = kindOf(upload);
  if (!kind) throw new HttpError(400, 'The resume must be a PDF or a .txt file.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(upload.base64)) throw new HttpError(400, 'The resume file could not be read.');
  const bytes = Buffer.from(upload.base64, 'base64');
  if (bytes.length > MAX_RESUME_BYTES) throw new HttpError(400, 'The resume file is larger than 2 MB.');
  if (bytes.length === 0) throw new HttpError(400, 'The resume file is empty.');

  let raw: string;
  if (kind === 'txt') {
    raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } else {
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, "That file isn't a readable PDF.");
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      raw = text;
    } catch {
      throw new HttpError(400, "That PDF couldn't be read. Try saving it again, or upload a .txt file instead.");
    }
  }

  const text = normalizeText(raw);
  if (text.length === 0) {
    throw new HttpError(
      400,
      kind === 'pdf'
        ? 'No text was found in that PDF. It may be a scanned image; upload a PDF with selectable text or a .txt file.'
        : 'The resume file is empty.',
    );
  }
  // Capped, not refused: a long resume is screened on its first 20,000 characters, and the
  // screening records that it was cut.
  return { text: text.slice(0, MAX_RESUME_CHARS), truncated: text.length > MAX_RESUME_CHARS, originalChars: text.length };
}
