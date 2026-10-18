import { transport } from './transport';

export type UnlistenFn = () => void;
export type Event<T> = { event: string; id: number; payload: T };
export type EventCallback<T> = (event: Event<T>) => void;

export async function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return transport.listen(event, handler as never);
}

export async function once<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const off = await listen<T>(event, (e) => {
    off();
    handler(e);
  });
  return off;
}

/** The phone only receives events; nothing it emits is meant for the Mac. */
export async function emit(): Promise<void> {}
