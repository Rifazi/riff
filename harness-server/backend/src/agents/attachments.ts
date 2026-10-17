import { PDFParse } from 'pdf-parse';
import { htmlToText, looksLikeHtml, looksLikeMime, mimeHtmlPart } from './html-text.js';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import { appendTranscriptEntry } from '../sessions/session-store.js';
import { addReferenceDocs } from '../sessions/reference-docs.js';

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 200_000;
// A saved attachment longer than this goes into the turn as a pointer to its
// reference doc instead of in full — the agent reads the parts it needs.
const MAX_INLINE_CHARS = 30_000;

export interface AttachmentInput {
  name: string;
  mediaType: string;
  /** Base64-encoded file bytes. */
  data: string;
}

export interface ParsedAttachment {
  name: string;
  text: string;
  // Set once saved as one of the session's reference docs (see
  // saveAsReferenceDocs) — the read_doc path for it.
  referencePath?: string;
}

/**
 * Decodes and extracts text from uploaded attachments. Throws on anything
 * structurally invalid (oversized, unsupported type, unreadable PDF) — same
 * convention as the rest of this project's tool layer: a request that can't
 * actually be honored should fail loudly, not silently produce a partial
 * result the agent has no way to know is incomplete.
 */
export async function parseAttachments(inputs: AttachmentInput[]): Promise<ParsedAttachment[]> {
  return Promise.all(inputs.map(parseAttachment));
}

async function parseAttachment(input: AttachmentInput): Promise<ParsedAttachment> {
  const buffer = Buffer.from(input.data, 'base64');
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
    throw new Error(
      `${input.name} is ${mb(buffer.byteLength)}MB — attachments are capped at ${mb(MAX_ATTACHMENT_BYTES)}MB.`
    );
  }

  const isPdf = input.mediaType === 'application/pdf' || /\.pdf$/i.test(input.name);
  const isWord =
    /\.docx?$/i.test(input.name) ||
    input.mediaType === 'application/msword' ||
    input.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isText = input.mediaType.startsWith('text/') || /\.(md|markdown|txt|csv|json|ya?ml)$/i.test(input.name);
  const mightBeText = input.mediaType === 'application/octet-stream' || input.mediaType === '';

  let text: string;
  if (isPdf) {
    const parser = new PDFParse({ data: buffer });
    try {
      text = (await parser.getText()).text.trim();
    } finally {
      await parser.destroy();
    }
    if (!text) {
      throw new Error(`${input.name}: no extractable text found — it may be a scanned/image-only PDF.`);
    }
  } else if (isWord) {
    text = await extractWordText(input.name, buffer);
  } else if (isText) {
    text = buffer.toString('utf8');
  } else if (mightBeText) {
    // Browser sends application/octet-stream for unrecognized types (e.g. .ts, .py, .toml).
    // Try UTF-8 decoding; reject if null bytes are found (indicates a real binary file).
    const decoded = buffer.toString('utf8');
    if (decoded.includes('\0')) {
      throw new Error(
        `${input.name}: unsupported file type "${input.mediaType}" — attach a PDF, Word document or plain-text/code file.`
      );
    }
    text = decoded;
  } else {
    throw new Error(
      `${input.name}: unsupported file type "${input.mediaType || 'unknown'}" — attach a PDF, Word document or plain-text/markdown file.`
    );
  }

  if (text.length > MAX_EXTRACTED_CHARS) {
    const omitted = text.length - MAX_EXTRACTED_CHARS;
    text = `${text.slice(0, MAX_EXTRACTED_CHARS)}\n\n[... truncated, ${omitted.toLocaleString()} more characters omitted ...]`;
  }

  return { name: input.name, text };
}

// A .docx is a zip (PK), a legacy .doc an OLE2 container; the extension and
// media type are often wrong, so the bytes decide.
async function extractWordText(name: string, buffer: Buffer): Promise<string> {
  const isZip = buffer.subarray(0, 2).toString('latin1') === 'PK';
  const isOle = buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  let text: string;
  try {
    if (isZip) {
      text = (await mammoth.extractRawText({ buffer })).value;
    } else if (isOle) {
      text = (await new WordExtractor().extract(buffer)).getBody();
    } else {
      const head = buffer.subarray(0, 2048).toString('utf8');
      // Word's "web page" and Confluence/Jira exports are HTML (or MHTML) saved as .doc.
      const html = looksLikeMime(head) ? mimeHtmlPart(buffer.toString('latin1')) : looksLikeHtml(head) ? buffer.toString('utf8') : null;
      if (html === null) throw new Error('not a Word, HTML or MHTML file');
      return htmlToText(html);
    }
  } catch (err) {
    throw new Error(`${name}: could not read the Word document (${err instanceof Error ? err.message : String(err)}).`);
  }
  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error(`${name}: no extractable text found in the Word document.`);
  return text;
}

/**
 * Saves a chat message's attachments as the session's reference docs, so
 * every later stage and agent can read them without the human attaching
 * them again. Returns them with referencePath set.
 */
export async function saveAsReferenceDocs(sessionId: string, attachments: ParsedAttachment[]): Promise<ParsedAttachment[]> {
  const saved = await addReferenceDocs({ kind: 'session', sessionId }, attachments);
  return attachments.map((att, i) => ({ ...att, referencePath: saved[i].path }));
}

/**
 * Logs one transcript entry per attachment (so the chat shows what was
 * attached without dumping the full extracted text into a bubble) and
 * returns the prompt string to actually send to the model: the human's
 * message followed by each attachment's extracted text, clearly delimited
 * so the model can tell where one file ends and the next begins.
 */
export async function applyAttachments(
  sessionId: string,
  stage: 'requirements' | 'plan' | 'coding' | 'qa',
  userMessage: string,
  attachments: ParsedAttachment[]
): Promise<string> {
  if (attachments.length === 0) return userMessage;

  for (const att of attachments) {
    await appendTranscriptEntry(sessionId, stage, {
      role: 'system',
      text: `Attached: ${att.name} (${att.text.length.toLocaleString()} characters extracted${
        att.referencePath ? ' — saved for every agent in this session' : ''
      })`,
    });
  }

  const blocks = attachments
    .map((att) =>
      att.referencePath && att.text.length > MAX_INLINE_CHARS
        ? `--- Attached file: ${att.name} (${att.text.length.toLocaleString()} characters — too long to paste here; ` +
          `saved as ${att.referencePath}, so search it with search_docs and read the sections you need with read_doc) ---`
        : `--- Attached file: ${att.name} ---\n${att.text}\n--- end ${att.name} ---`
    )
    .join('\n\n');

  return `${userMessage}\n\n${blocks}`;
}
