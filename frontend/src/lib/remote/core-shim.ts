import { transport } from './transport';

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return transport.invoke<T>(cmd, args);
}

/** Asset URLs point at files on the Mac and can't be opened from the phone. */
export function convertFileSrc(path: string): string {
  return path;
}

export const isTauri = () => false;

export class Channel<T = unknown> {
  onmessage: (response: T) => void = () => {};
}

/** Handle to an object living on the Mac (the store plugin hands these out). */
export class Resource {
  readonly #rid: number;
  get rid(): number {
    return this.#rid;
  }
  constructor(rid: number) {
    this.#rid = rid;
  }
  async close(): Promise<void> {
    return invoke('plugin:resources|close', { rid: this.rid });
  }
}
