'use client';

import Link from 'next/link';
import { Check, Lock } from 'lucide-react';
import type { SessionRecord } from '@/lib/dev-sessions/types';
import {
  hasStageActivity,
  isStageCompleted,
  isStageReached,
  sessionHref,
  STAGE_GROUPS,
  type StageGroup,
} from '@/lib/dev-sessions/stage';
import { AGENT_PERSONAS } from '@/lib/dev-sessions/agents';

export function StageStepper({ session, current }: { session: SessionRecord; current: StageGroup }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {STAGE_GROUPS.map(({ group, label }, index) => {
        const agent = AGENT_PERSONAS[group];
        const reached = isStageReached(session, group);
        const completed = isStageCompleted(session, group);
        const active = hasStageActivity(session, group);
        const isCurrent = group === current;
        const statusText = completed ? 'Done' : active ? 'In progress' : reached ? 'Ready to start' : 'Not started';

        const content = (
          <div className="flex items-center gap-3">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                completed
                  ? 'bg-green-100 text-green-700'
                  : isCurrent
                    ? 'bg-blue-600 text-white'
                    : reached
                      ? 'bg-gray-100 text-gray-700'
                      : 'bg-gray-100 text-gray-400'
              }`}
            >
              {completed ? <Check className="w-4 h-4" /> : reached ? index + 1 : <Lock className="w-3.5 h-3.5" />}
            </div>
            <div className="min-w-0">
              <div className={`text-sm font-semibold truncate ${isCurrent ? 'text-blue-700' : 'text-gray-900'}`}>{label}</div>
              <div className="text-xs text-gray-500 truncate" title={agent.fullName}>
                {agent.name} · {statusText}
              </div>
            </div>
          </div>
        );

        const base = 'rounded-lg border px-3 py-2.5 transition-colors';
        if (!reached) {
          return (
            <div
              key={group}
              className={`${base} border-gray-200 bg-gray-50 opacity-70 cursor-not-allowed`}
              title={`${agent.name} (${label}) isn't reachable yet — finish the earlier stage first.`}
            >
              {content}
            </div>
          );
        }
        return (
          <Link
            key={group}
            href={sessionHref(session.id, group)}
            className={`${base} ${
              isCurrent ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            {content}
          </Link>
        );
      })}
    </div>
  );
}
