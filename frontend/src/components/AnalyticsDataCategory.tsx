'use client';

import React from 'react';

export interface AnalyticsDataCategoryProps {
  /** Position in the list, rendered as the "1." prefix. */
  index: number;
  title: string;
  items: string[];
  /** Why this category is collected, shown under the list. */
  note: string;
}

/**
 * One "what analytics collects" category in {@link AnalyticsDataModal} —
 * a numbered heading, its bullet list, and the reason it's collected.
 * Extracted so the modal reads as a list of categories rather than five
 * copies of the same markup.
 */
export function AnalyticsDataCategory({ index, title, items, note }: AnalyticsDataCategoryProps) {
  return (
    <div className="rounded-lg border border-border p-4">
      <h4 className="mb-2 font-semibold text-foreground">
        {index}. {title}
      </h4>
      <ul className="ml-4 space-y-1 text-sm text-foreground">
        {items.map((item) => (
          <li key={item}>• {item}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs italic text-muted-foreground">{note}</p>
    </div>
  );
}
