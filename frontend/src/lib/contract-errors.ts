import { ContractErrors, type ContractErrorCode } from "@/generated/contract-types";

/** Human-readable messages for on-chain SplitError codes (contracts/errors.rs). */
export const CONTRACT_ERROR_MESSAGES: Record<ContractErrorCode, string> = {
  [ContractErrors.ProjectExists]:
    "A project with this ID already exists. Choose a different project ID.",
  [ContractErrors.NotFound]: "Project not found on-chain. It may have been archived or never created.",
  [ContractErrors.Unauthorized]:
    "You are not authorized for this action. Connect the project owner or contract admin wallet.",
  [ContractErrors.InvalidSplit]:
    "Collaborator shares must total exactly 10,000 basis points (100%).",
  [ContractErrors.TooFewCollaborators]: "At least two collaborators are required.",
  [ContractErrors.ZeroShare]: "Each collaborator must have a share greater than zero.",
  [ContractErrors.NoBalance]: "There is no balance available to distribute for this project.",
  [ContractErrors.AlreadyLocked]: "This project is already locked and cannot be changed.",
  [ContractErrors.ProjectLocked]:
    "This project is locked. Unlock is not supported — create a new project instead.",
  [ContractErrors.DuplicateCollaborator]: "Duplicate collaborator addresses are not allowed.",
  [ContractErrors.InvalidAmount]: "Amount must be greater than zero.",
  [ContractErrors.TokenNotAllowed]:
    "This token is not on the contract allowlist. Ask the admin to allow it first.",
  [ContractErrors.AdminNotSet]: "Contract admin is not configured yet.",
  [ContractErrors.ArithmeticOverflow]:
    "An internal balance calculation overflowed. Contact support with the transaction hash.",
  [ContractErrors.InsufficientUnallocated]:
    "Withdrawal exceeds unallocated contract balance for this token.",
  [ContractErrors.DistributionsPaused]:
    "Distributions are paused by the contract admin. Deposits still work; try again after unpause.",
  [ContractErrors.InvalidRecipient]: "Withdrawal recipient must not be the contract itself.",
  [ContractErrors.NotACollaborator]: "Address is not registered as a collaborator on this project.",
  [ContractErrors.TooManyCollaborators]: "Project has exceeded the maximum allowed number of collaborators.",
  [ContractErrors.AccountingDiscrepancy]:
    "Contract accounting detected a balance mismatch. Pause and review before retrying.",
  [ContractErrors.InvalidMaxCollaborators]:
    "Maximum collaborators must stay within the contract bounds."
};

const ERROR_CODE_BY_NAME = Object.fromEntries(
  Object.entries(ContractErrors).map(([name, code]) => [name, code])
) as Record<string, ContractErrorCode>;

/**
 * Maps Soroban contract error payloads embedded in RPC/ledger failure strings
 * to operator-friendly messages. Returns null when no known code is detected.
 */
export function parseContractError(raw: string): string | null {
  if (!raw) return null;

  const numeric =
    raw.match(/#(\d{1,2})\b/)?.[1]
    ?? raw.match(/(?:error|code|Error)\s*[:=]?\s*(\d{1,2})\b/i)?.[1]
    ?? raw.match(/\bError\((\d{1,2})\)/)?.[1]
    ?? raw.match(/\bcontract error[:\s]+(\d{1,2})\b/i)?.[1];

  if (numeric) {
    const code = Number(numeric) as ContractErrorCode;
    if (CONTRACT_ERROR_MESSAGES[code]) {
      return CONTRACT_ERROR_MESSAGES[code];
    }
  }

  for (const [name, code] of Object.entries(ERROR_CODE_BY_NAME)) {
    if (raw.includes(name)) {
      return CONTRACT_ERROR_MESSAGES[code];
    }
  }

  return null;
}

/**
 * Prefer a parsed contract error message; otherwise return the original text.
 */
export function formatContractFailure(raw: string, fallback = "Transaction failed on ledger."): string {
  return parseContractError(raw) ?? (raw.trim() || fallback);
}

// ─── Simulation failure categories (issue #1495) ─────────────────────────────

/**
 * Stable, machine-checkable classes for a failed simulation.
 *
 * The previous behaviour returned `errorResult.toString()` verbatim — a raw
 * host/protocol string such as `HostError: Error(Contract, #1)`. That text is
 * neither stable (it changes between SDK and host versions) nor actionable (it
 * names no remedy), so callers could not branch on it and users could not act
 * on it.
 *
 * The category is the stable half; the message is the user-facing half. Callers
 * that need to retry, prompt, or escalate branch on `category`. Anything not
 * recognised lands in `unknown` rather than being guessed into one of the
 * actionable buckets.
 */
export const SIMULATION_FAILURE_CATEGORIES = [
  "contract_error",
  "insufficient_funds",
  "sequence_mismatch",
  "signature_mismatch",
  "network",
  "unknown",
] as const;

export type SimulationFailureCategory = (typeof SIMULATION_FAILURE_CATEGORIES)[number];

/** User-facing text per category. Written as what to do, not what broke. */
const SIMULATION_FAILURE_MESSAGES: Record<SimulationFailureCategory, string> = {
  contract_error:
    "The contract rejected this transaction. Review the details below and adjust your inputs.",
  insufficient_funds:
    "This account does not have enough funds or resources to cover the transaction, including fees.",
  sequence_mismatch:
    "This account has newer activity than the transaction accounted for. Reload and submit again.",
  signature_mismatch:
    "This transaction was not signed by the submitting account. Reconnect the correct wallet and sign again.",
  network: "The network could not be reached. Check your connection and try again.",
  unknown: "The transaction could not be prepared. See the details below.",
};

/**
 * Patterns matched in order against the raw simulation error text.
 *
 * Ordered most-specific first, because the order is the whole point: a
 * `tx_bad_seq` string also matches the general "insufficient|overrun" rule
 * nowhere, but `tx_insufficient_fee` *does* match a broader fee rule, and the
 * two need different advice — one is about the account's sequence, the other
 * about its balance.
 */
const SIMULATION_FAILURE_RULES: ReadonlyArray<readonly [RegExp, SimulationFailureCategory]> = [
  [/tx_bad_seq|bad\s+seq/i, "sequence_mismatch"],
  [/tx_bad_auth|bad\s+signature|not_enough_signature_weight/i, "signature_mismatch"],
  [/insufficient|overrun|exceeded|exhausted/i, "insufficient_funds"],
  [/error\(contract|#\d+|contract\s+error/i, "contract_error"],
  [/timeout|network|econnrefused|econnreset|socket|unavailable|offline|try_again_later/i, "network"],
];

export interface SimulationFailure {
  /** Stable class for branching. Safe to compare against. */
  category: SimulationFailureCategory;
  /** User-facing, actionable text. Never contains raw protocol output. */
  message: string;
  /**
   * Sanitized diagnostic, for logs and error reports only.
   *
   * A simulation error can embed XDR, and XDR carries contract arguments — which
   * for this contract include amounts and addresses. Handing the raw string to a
   * toast, a URL, or a third-party error reporter leaks the transaction the user
   * was trying to make, so everything from the first argument onwards is
   * dropped here rather than only at the reporting layer.
   */
  diagnostic: string;
}

/** Longest diagnostic retained: enough to identify a host error, too short to carry XDR. */
const MAX_DIAGNOSTIC_LENGTH = 120;

/**
 * Keeps only the diagnostic prefix of a simulation error.
 *
 * `errorResult` is commonly `Error(Contract, #1, <base64 XDR>)`. The first
 * segment names the failure; everything after it is transaction content.
 */
function sanitizeDiagnostic(raw: string): string {
  const collapsed = raw.split(",")[0].trim().replace(/\s+/g, " ");
  return collapsed.slice(0, MAX_DIAGNOSTIC_LENGTH) || "unspecified";
}

/**
 * Maps a raw simulation failure to a stable category with a user-facing message.
 *
 * Issue #1495. Never throws and never returns the raw text as the message: an
 * unmapped failure still gets a category (`unknown`) and something the user can
 * read, while the original survives only in `diagnostic`.
 */
export function classifySimulationFailure(raw: string | null | undefined): SimulationFailure {
  const text = typeof raw === "string" ? raw : "";

  if (!text) {
    return {
      category: "unknown",
      message: SIMULATION_FAILURE_MESSAGES.unknown,
      diagnostic: "unspecified",
    };
  }

  const diagnostic = sanitizeDiagnostic(text);
  // A contract revert carries a SplitError code the caller can act on, so its
  // specific message beats the generic per-category text.
  const contractMessage = parseContractError(text);

  for (const [pattern, category] of SIMULATION_FAILURE_RULES) {
    if (pattern.test(text)) {
      return {
        category,
        message: contractMessage ?? SIMULATION_FAILURE_MESSAGES[category],
        diagnostic,
      };
    }
  }

  return {
    category: "unknown",
    message: contractMessage ?? SIMULATION_FAILURE_MESSAGES.unknown,
    diagnostic,
  };
}
