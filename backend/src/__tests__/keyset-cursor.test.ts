import { describe, expect, it } from "vitest";
import {
  decodeTransactionCursor,
  encodeTransactionCursor,
  InvalidTransactionCursorError,
} from "../lib/keyset-cursor.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("transaction keyset cursor", () => {
  it("round-trips a timestamp and row id", () => {
    const encoded = encodeTransactionCursor({ timestamp: 1_700_000_000, id: ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTransactionCursor(encoded)).toEqual({
      timestamp: 1_700_000_000,
      id: ID,
    });
  });

  it("encodes an opaque value rather than readable JSON", () => {
    const encoded = encodeTransactionCursor({ timestamp: 1_700_000_000, id: ID });
    expect(encoded).not.toContain("timestamp");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toContain('"t"');
  });

  it.each([
    ["empty", ""],
    ["not base64url", "not a cursor!!"],
    ["valid base64 but not JSON", Buffer.from("hello").toString("base64url")],
    ["JSON without fields", Buffer.from("{}").toString("base64url")],
    ["negative timestamp", Buffer.from(JSON.stringify({ t: -1, i: ID })).toString("base64url")],
    ["fractional timestamp", Buffer.from(JSON.stringify({ t: 1.5, i: ID })).toString("base64url")],
    ["missing id", Buffer.from(JSON.stringify({ t: 1 })).toString("base64url")],
    ["non-UUID id", Buffer.from(JSON.stringify({ t: 1, i: "row-1" })).toString("base64url")],
    ["oversized", "a".repeat(513)],
  ])("rejects %s", (_label, raw) => {
    expect(() => decodeTransactionCursor(raw)).toThrow(InvalidTransactionCursorError);
  });

  it("refuses to encode an invalid cursor", () => {
    expect(() => encodeTransactionCursor({ timestamp: -1, id: ID })).toThrow(
      InvalidTransactionCursorError
    );
    expect(() => encodeTransactionCursor({ timestamp: 1, id: "not-a-uuid" })).toThrow(
      InvalidTransactionCursorError
    );
  });
});
