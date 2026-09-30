import type { AttachmentInput } from './types';

// Mirrors the cap in harness-server/backend/src/agents/attachments.ts —
// checked here too so an oversized file is rejected before a round trip.
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const ACCEPTED_ATTACHMENT_TYPES = '.pdf,.txt,.md,.markdown,.csv,.json,.yml,.yaml,text/plain,text/markdown,application/pdf';

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:<mediaType>;base64,<data>" — the backend expects
      // only the payload after the comma.
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Reads picked files for upload. Throws on one over the size cap. */
export async function readAttachments(fileList: FileList): Promise<AttachmentInput[]> {
  const files = Array.from(fileList);
  const oversized = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
  if (oversized) {
    throw new Error(`${oversized.name} is over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB attachment limit.`);
  }
  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      mediaType: file.type || 'application/octet-stream',
      data: await readFileAsBase64(file),
    }))
  );
}
