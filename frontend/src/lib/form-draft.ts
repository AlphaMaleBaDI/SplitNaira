/**
 * Safe persistence of in-progress form input (create-split wizard).
 *
 * Drafts survive a dropped connection, a failed submit or a reload, so users
 * don't retype a split. What is "safe" is decided by an allowlist, not by
 * stripping known-bad fields:
 *
 * - only the declared fields are written (projectId, title, projectType,
 *   token, collaborators[].address/alias/basisPoints, expiresAt);
 * - any value that looks like a Stellar secret seed (`S…`, 56 chars) or exceeds
 *   the field's length cap is dropped;
 * - storage is `sessionStorage` (tab-scoped, cleared when the tab closes) and
 *   keyed per wallet account, so a draft never leaks to another account;
 * - drafts expire after `DRAFT_TTL_MS`, carry a schema version, and anything
 *   malformed is discarded on read.
 *
 * Storage failures (private mode, quota, disabled storage) are swallowed:
 * drafts are a convenience and must never break the form.
 */

export const DRAFT_VERSION = 1;
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = "splitnaira:draft";
const SECRET_SEED = /\bS[A-Z2-7]{55}\b/;
const MAX_COLLABORATORS = 50;

export interface DraftCollaborator {
  address: string;
  alias: string;
  basisPoints: string;
}

export interface CreateSplitDraft {
  projectId: string;
  title: string;
  projectType: string;
  token: string;
  collaborators: DraftCollaborator[];
  expiresAt: string;
}

const FIELD_LIMITS = {
  projectId: 32,
  title: 200,
  projectType: 50,
  token: 56,
  expiresAt: 40,
  address: 56,
  alias: 100,
  basisPoints: 5,
} as const;

function safeString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  if (value.length > max || SECRET_SEED.test(value)) return "";
  return value;
}

/** Projects arbitrary form values onto the allowlisted draft shape. */
export function toSafeDraft(values: unknown): CreateSplitDraft {
  const v = (values && typeof values === "object" ? values : {}) as Record<string, unknown>;
  const collaborators = Array.isArray(v.collaborators) ? v.collaborators.slice(0, MAX_COLLABORATORS) : [];
  return {
    projectId: safeString(v.projectId, FIELD_LIMITS.projectId),
    title: safeString(v.title, FIELD_LIMITS.title),
    projectType: safeString(v.projectType, FIELD_LIMITS.projectType),
    token: safeString(v.token, FIELD_LIMITS.token),
    expiresAt: safeString(v.expiresAt, FIELD_LIMITS.expiresAt),
    collaborators: collaborators.map((c) => {
      const row = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      return {
        address: safeString(row.address, FIELD_LIMITS.address),
        alias: safeString(row.alias, FIELD_LIMITS.alias),
        basisPoints: safeString(row.basisPoints, FIELD_LIMITS.basisPoints),
      };
    }),
  };
}

export function isEmptyDraft(draft: CreateSplitDraft): boolean {
  return (
    !draft.projectId &&
    !draft.title &&
    !draft.token &&
    !draft.expiresAt &&
    draft.collaborators.every((c) => !c.address && !c.alias)
  );
}

export function draftStorageKey(form: string, account: string | null): string {
  return `${PREFIX}:${form}:${account ? account.trim().toUpperCase() : "anonymous"}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveDraft(form: string, account: string | null, values: unknown, now = Date.now()): void {
  const store = storage();
  if (!store) return;
  const draft = toSafeDraft(values);
  try {
    if (isEmptyDraft(draft)) {
      store.removeItem(draftStorageKey(form, account));
      return;
    }
    store.setItem(
      draftStorageKey(form, account),
      JSON.stringify({ version: DRAFT_VERSION, savedAt: now, values: draft }),
    );
  } catch {
    /* quota or disabled storage: drafts are best-effort */
  }
}

export function loadDraft(form: string, account: string | null, now = Date.now()): CreateSplitDraft | null {
  const store = storage();
  if (!store) return null;
  const key = draftStorageKey(form, account);
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: unknown; savedAt?: unknown; values?: unknown };
    const fresh =
      parsed.version === DRAFT_VERSION &&
      typeof parsed.savedAt === "number" &&
      now - parsed.savedAt >= 0 &&
      now - parsed.savedAt <= DRAFT_TTL_MS;
    if (!fresh) {
      store.removeItem(key);
      return null;
    }
    const draft = toSafeDraft(parsed.values);
    return isEmptyDraft(draft) ? null : draft;
  } catch {
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function clearDraft(form: string, account: string | null): void {
  try {
    storage()?.removeItem(draftStorageKey(form, account));
  } catch {
    /* ignore */
  }
}
