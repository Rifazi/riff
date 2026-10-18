'use client';

import React, { useState } from 'react';

/**
 * Chat on the left, the stage's document/diff/report on the right, both filling the viewport.
 * On a phone only one shows at a time, behind a Chat / Document switch (both stay mounted, so
 * a streaming reply and the open document keep their state when you flip between them).
 */
export function StageLayout({
  toolbar,
  chat,
  document,
  below,
}: {
  toolbar?: React.ReactNode;
  chat: React.ReactNode;
  document: React.ReactNode;
  below?: React.ReactNode;
}) {
  const [phonePane, setPhonePane] = useState<'chat' | 'document'>('chat');
  const pane = 'h-[80vh] min-h-[420px] max-lg:overflow-y-auto custom-scrollbar lg:h-auto lg:min-h-0 flex flex-col max-md:h-[calc(100dvh-var(--phone-bar,0px)-21rem)] max-md:min-h-[320px]';

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 max-lg:flex-none max-lg:min-h-fit">
      {toolbar && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 flex-shrink-0">{toolbar}</div>}
      <div className="flex-shrink-0 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 md:hidden" role="tablist">
        {(['chat', 'document'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={phonePane === p}
            onClick={() => setPhonePane(p)}
            className={`rounded-md py-2 text-sm font-medium capitalize ${
              phonePane === p ? 'bg-background text-foreground shadow' : 'text-muted-foreground'
            }`}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4 max-lg:flex-none">
        <div className={`${pane} ${phonePane === 'chat' ? '' : 'max-md:hidden'}`}>{chat}</div>
        <div className={`${pane} ${phonePane === 'document' ? '' : 'max-md:hidden'}`}>{document}</div>
      </div>
      {/* Pinned to the bottom of a phone screen, so Approve is always in reach below the tall pane. */}
      {below && (
        <div className="flex-shrink-0 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-4 max-md:bg-background max-md:px-4 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {below}
        </div>
      )}
    </div>
  );
}
