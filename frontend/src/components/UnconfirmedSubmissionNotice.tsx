"use client";

import type { UnconfirmedSubmission } from "@/lib/submission-guard";

const ACTION_LABELS: Record<string, string> = {
  create: "Split creation",
  deposit: "Deposit",
  distribute: "Payout",
  lock: "Project lock",
};

interface UnconfirmedSubmissionNoticeProps {
  submissions: Readonly<Record<string, UnconfirmedSubmission>>;
  checkingAction: string | null;
  onCheck: (action: string) => void;
}

/**
 * Shown while a submitted transaction has no confirmed outcome (#1266). The
 * matching action stays disabled until "Check status" finds a definitive
 * result, or the transaction's validity window passes, so the user can't
 * accidentally submit the same payment twice.
 */
export function UnconfirmedSubmissionNotice({
  submissions,
  checkingAction,
  onCheck,
}: UnconfirmedSubmissionNoticeProps) {
  const entries = Object.entries(submissions);
  if (entries.length === 0) return null;

  return (
    <section
      aria-labelledby="unconfirmed-submissions-title"
      className="mb-6 rounded-2xl border border-orange-400/40 bg-orange-500/10 p-4 text-sm"
    >
      <h2 id="unconfirmed-submissions-title" className="font-semibold text-orange-200">
        Waiting for network confirmation
      </h2>
      <p className="mt-1 text-orange-100/90">
        These transactions were submitted but not confirmed yet. To avoid paying twice, the action stays
        disabled until the outcome is known.
      </p>
      <ul className="mt-3 space-y-2">
        {entries.map(([action, submission]) => (
          <li key={action} className="flex flex-wrap items-center justify-between gap-3">
            <span>
              <span className="font-semibold text-orange-100">{ACTION_LABELS[action] ?? action}</span>{" "}
              <span className="font-mono text-[10px] text-orange-100/70 break-all">{submission.hash}</span>
            </span>
            <button
              type="button"
              onClick={() => onCheck(action)}
              disabled={checkingAction === action}
              aria-busy={checkingAction === action}
              className="rounded-xl border border-orange-300/40 bg-orange-400/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-orange-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkingAction === action ? "Checking…" : "Check status"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
