import React from 'react';

/** Chat on the left, the stage's document/diff/report on the right, both filling the viewport. */
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
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      {toolbar && <div className="flex flex-wrap items-center gap-4 flex-shrink-0">{toolbar}</div>}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="min-h-[420px] lg:min-h-0 flex flex-col">{chat}</div>
        <div className="min-h-[420px] lg:min-h-0 flex flex-col">{document}</div>
      </div>
      {below && <div className="flex-shrink-0">{below}</div>}
    </div>
  );
}
