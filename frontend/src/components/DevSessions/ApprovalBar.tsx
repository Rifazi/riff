'use client';

import { useState } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Pill } from './PageShell';
import { ConfirmDialog } from './ConfirmDialog';

interface ApprovalBarProps {
  approveLabel: string;
  onApprove: () => void;
  approveDisabled: boolean;
  approveDisabledReason?: string;
  busy?: boolean;
  onReject?: () => void;
  rejectDisabled?: boolean;
  rejectBusy?: boolean;
}

export function ApprovalBar({
  approveLabel,
  onApprove,
  approveDisabled,
  approveDisabledReason,
  busy,
  onReject,
  rejectDisabled,
  rejectBusy,
}: ApprovalBarProps) {
  const [confirmingReject, setConfirmingReject] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3 mt-3 border-t border-gray-100">
      <Button variant="green" onClick={onApprove} disabled={approveDisabled || busy}>
        {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
        {busy ? 'Working…' : approveLabel}
      </Button>
      {onReject && (
        <Button variant="outline" onClick={() => setConfirmingReject(true)} disabled={rejectDisabled || rejectBusy}>
          {rejectBusy ? <Loader2 className="animate-spin" /> : <XCircle className="text-red-500" />}
          {rejectBusy ? 'Working…' : 'Reject'}
        </Button>
      )}
      {approveDisabled && approveDisabledReason && <Pill>{approveDisabledReason}</Pill>}
      {onReject && (
        <ConfirmDialog
          open={confirmingReject}
          title="Reject and abandon this session?"
          description="The branch and any documents already written stay in place. You can reopen the session later from the Dev Sessions list."
          confirmLabel="Reject"
          destructive
          onCancel={() => setConfirmingReject(false)}
          onConfirm={() => {
            setConfirmingReject(false);
            onReject();
          }}
        />
      )}
    </div>
  );
}
