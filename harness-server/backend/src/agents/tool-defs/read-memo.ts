import { createHash } from 'node:crypto';

/**
 * What read_file and read_doc have returned in the current conversation. A
 * read the model repeats with nothing changed is answered with a short note
 * instead of the same text again, since the first copy is still in its
 * context. The same read asked for once more gets the text, so a read that
 * dropped out of the context can always be fetched again.
 *
 * One memo per conversation, shared by an agent's read tools: `clear()` it
 * when compaction starts a fresh conversation. The old copies are gone then,
 * and the note only cost the agent a request to get past it (41 times in one
 * session before this).
 */
export class ReadMemo {
  private lastReads = new Map<string, string>();
  private notedRepeats = new Map<string, string>();

  /** True when this read should get the note instead of `text`. */
  isRepeat(key: string, text: string): boolean {
    const hash = createHash('sha1').update(text).digest('hex');
    if (this.lastReads.get(key) === hash && this.notedRepeats.get(key) !== hash) {
      this.notedRepeats.set(key, hash);
      return true;
    }
    this.notedRepeats.delete(key);
    this.lastReads.set(key, hash);
    return false;
  }

  clear(): void {
    this.lastReads.clear();
    this.notedRepeats.clear();
  }
}
