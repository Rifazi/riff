'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';

// Mirrors frontend/src-tauri/src/search (commands.rs) and search/src/lib.rs (Hit).
// Every search in the app goes through here, so meetings and journals rank
// results the same way: keyword matches (stemmed) fused with matches by meaning.

export type SearchKind = 'transcript' | 'summary' | 'journal' | 'journal_note';

export interface SearchHit {
  key: string;
  kind: SearchKind;
  /** Meeting title, journal title or note title. */
  title: string;
  /** Meeting id or journal id: what results are grouped by. */
  group: string;
  date: string | null;
  meta: {
    meetingId?: string;
    notebookId?: string;
    notebookTitle?: string;
    entryId?: string;
    meetingTitle?: string;
    color?: string;
  };
  heading: string | null;
  text: string;
  /** Excerpt; matched words are wrapped in SNIPPET_MARK_START / SNIPPET_MARK_END. */
  snippet: string;
  /** Seconds into the recording, for transcript hits. */
  start: number | null;
  end: number | null;
  score: number;
  /** Matched by keyword. */
  keyword: boolean;
  /** Matched by meaning. */
  semantic: boolean;
  /** Other matches in the same meeting or journal, best first. */
  also?: SearchHit[];
}

export const SNIPPET_MARK_START = '\u0002';
export const SNIPPET_MARK_END = '\u0003';

export interface SearchModelStatus {
  id: string;
  sizeBytes: number;
  installed: boolean;
  loaded: boolean;
  downloading: boolean;
  downloadedBytes: number;
  declined: boolean;
  error: string | null;
}

export interface SearchStatus {
  documents: number;
  chunks: number;
  embedded: number;
  model: SearchModelStatus;
  indexPath: string;
}

export const MEETING_KINDS: SearchKind[] = ['transcript', 'summary'];
export const JOURNAL_KINDS: SearchKind[] = ['journal', 'journal_note'];

export const searchKeys = {
  all: ['search'] as const,
  status: ['search', 'status'] as const,
  query: (query: string, kinds: SearchKind[]) => ['search', 'query', query, kinds.join(',')] as const,
};

export const searchApi = {
  search: (query: string, kinds: SearchKind[], limit = 50) =>
    invoke<SearchHit[]>('search', { query, kinds, limit, grouped: true }),
  status: () => invoke<SearchStatus>('search_status'),
  downloadModel: () => invoke<void>('search_download_model'),
  removeModel: () => invoke<void>('search_remove_model'),
  rebuildIndex: () => invoke<void>('search_rebuild_index'),
};

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Grouped results for `query` (debounced); empty while the query is blank. */
export function useSearch(query: string, kinds: SearchKind[]) {
  const debounced = useDebounced(query.trim(), 200);
  const result = useQuery({
    queryKey: searchKeys.query(debounced, kinds),
    queryFn: () => searchApi.search(debounced, kinds),
    enabled: debounced.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
  const active = query.trim().length > 0;
  return {
    hits: active ? (result.data ?? []) : [],
    /** Typing, or waiting on the engine. */
    isSearching: active && (debounced !== query.trim() || result.isFetching),
    error: result.error,
  };
}

/** Index and model status, kept live by the `search-status` event. */
export function useSearchStatus() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const subscriptions = [
      listen<SearchStatus>('search-status', ({ payload }) => queryClient.setQueryData(searchKeys.status, payload)),
      listen<number>('search-model-progress', ({ payload }) =>
        queryClient.setQueryData<SearchStatus>(searchKeys.status, (old) =>
          old ? { ...old, model: { ...old.model, downloading: true, downloadedBytes: payload } } : old,
        ),
      ),
    ];
    Promise.all(subscriptions)
      .then((fns) => {
        const all = () => fns.forEach((fn) => fn());
        if (cancelled) all();
        else unlisten = all;
      })
      .catch(() => {
        // Not running inside Tauri.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);
  return useQuery({ queryKey: searchKeys.status, queryFn: searchApi.status });
}
