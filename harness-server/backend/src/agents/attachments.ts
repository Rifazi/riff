import { PDFParse } from 'pdf-parse';
import { appendTranscriptEntry } from '../sessions/session-store.js';

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 200_000;

export interface AttachmentInput {
  name: string;
  mediaType: string;
  /** Base64-encoded file bytes. */
  data: string;
}

export interface ParsedAttachment {
  name: string;
  text: string;
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
  const isText = input.mediaType.startsWith('text/') || /\.(md|markdown|txt|csv|json|ya?ml)$/i.test(input.name);

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
  } else if (isText) {
    text = buffer.toString('utf8');
  } else {
    throw new Error(
      `${input.name}: unsupported file type "${input.mediaType || 'unknown'}" — attach a PDF or a plain-text/markdown file.`
    );
  }

  if (text.length > MAX_EXTRACTED_CHARS) {
    const omitted = text.length - MAX_EXTRACTED_CHARS;
    text = `${text.slice(0, MAX_EXTRACTED_CHARS)}\n\n[... truncated, ${omitted.toLocaleString()} more characters omitted ...]`;
  }

  return { name: input.name, text };
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
      text: `Attached: ${att.name} (${att.text.length.toLocaleString()} characters extracted)`,
    });
  }

  const blocks = attachments
    .map((att) => `--- Attached file: ${att.name} ---\n${att.text}\n--- end ${att.name} ---`)
    .join('\n\n');

  return `${userMessage}\n\n${blocks}`;
}
