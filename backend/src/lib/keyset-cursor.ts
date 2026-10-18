/**
 * Opaque keyset cursor for transaction history (#1259).
 *
 * Transaction rows are ordered by `(timestamp DESC, id DESC)`. The cursor
 * carries the last row's pair so the next page can continue with a bounded
 * `WHERE` clause instead of an ever-growing `OFFSET`.
 *
 * The cursor is deliberately *not* signed. It contains only values the client
 * already receives in the response (`timestamp` and the row's UUID), and a
 * forged value can at most move the caller to a different page — it cannot
 * widen the filter, bypass authorization, or read a row that the same query
 * would not already return. It is validated strictly so malformed input fails
 * as a 400 instead of reaching SQL as an unbounded value.
 */

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CURSOR_LENGTH = 512;

export interface TransactionCursor {
  /** Unix seconds, matching `transactions.timestamp`. */
  timestamp: number;
  /** UUID primary key, used as the tie-breaker for equal timestamps. */
  id: string;
}

export class InvalidTransactionCursorError extends Error {
  constructor(message = "Invalid transaction cursor.") {
    super(message);
    this.name = "InvalidTransactionCursorError";
  }
}

interface EncodedCursor {
  t: number;
  i: string;
}

function isEncodedCursor(value: unknown): value is EncodedCursor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(candidate.t) &&
    (candidate.t as number) >= 0 &&
    typeof candidate.i === "string" &&
    UUID_PATTERN.test(candidate.i)
  );
}

export function encodeTransactionCursor(cursor: TransactionCursor): string {
  if (!isEncodedCursor({ t: cursor.timestamp, i: cursor.id })) {
    throw new InvalidTransactionCursorError();
  }

  return Buffer.from(JSON.stringify({ t: cursor.timestamp, i: cursor.id }), "utf8").toString(
    "base64url"
  );
}

export function decodeTransactionCursor(raw: string): TransactionCursor {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_CURSOR_LENGTH ||
    !BASE64URL_PATTERN.test(raw)
  ) {
    throw new InvalidTransactionCursorError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidTransactionCursorError();
  }

  if (!isEncodedCursor(parsed)) {
    throw new InvalidTransactionCursorError();
  }

  return { timestamp: parsed.t, id: parsed.i };
}
