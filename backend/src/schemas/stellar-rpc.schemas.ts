import type { xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
import { stellarAddressSchema } from "./splits.js";

/**
 * Issue #1494: schemas for every Soroban RPC response the backend consumes.
 *
 * Two layers, both enforced by `services/rpc-response-validation.ts`:
 *
 *  1. Wire schemas (`raw*`): the JSON-RPC result exactly as Soroban RPC sends
 *     it, checked by a response interceptor on the SDK's HTTP client before
 *     the SDK parses it. This covers SDK-internal calls too (`getAccount` uses
 *     `getLedgerEntries`, `prepareTransaction` uses `simulateTransaction`).
 *  2. Call-site schemas: the SDK-parsed response and the contract values
 *     decoded from it, checked where the backend reads them.
 *
 * Rules: only fields the backend (or the SDK parser it relies on) reads are
 * validated. Those are strict on type and format; unknown extra fields are
 * stripped, never rejected, so additive upstream changes keep working.
 * Fields the code already treats as optional stay optional.
 *
 * See docs/stellar-rpc-response-validation.md before adding a schema.
 */

const U32_MAX = 4_294_967_295;
const I128_MAX = (1n << 127n) - 1n;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const ledgerSequenceSchema = z.number().int().min(0).max(U32_MAX);

export const txHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex transaction hash");

export const base64XdrSchema = z
  .string()
  .min(1, "must not be empty")
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64-encoded XDR")
  .refine((value) => value.length % 4 === 0, "must be base64-encoded XDR");

export const ledgerTimestampSchema = z.string().datetime({ offset: true });

const contractStrKeySchema = z
  .string()
  .regex(/^C[A-Z2-7]{55}$/, "must be a contract address (C...)");

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export const jsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
});

export const jsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Wire schemas, keyed by JSON-RPC method
// ---------------------------------------------------------------------------

export const rawGetLatestLedgerResultSchema = z.object({
  sequence: ledgerSequenceSchema,
});

export const rawEventSchema = z.object({
  id: z.string().min(1),
  txHash: txHashSchema,
  // Older RPC servers may omit the ledger; the listener tolerates that.
  ledger: ledgerSequenceSchema.optional(),
  ledgerClosedAt: ledgerTimestampSchema,
  // The SDK builds a `Contract` from any non-empty value.
  contractId: z.union([z.literal(""), contractStrKeySchema]),
  topic: z.array(base64XdrSchema).optional(),
  value: base64XdrSchema,
});

export const rawGetEventsResultSchema = z.object({
  // Required: a response that omits `events` but carries a `cursor` would
  // otherwise advance the listener past events it never saw.
  events: z.array(rawEventSchema),
  cursor: z.string().optional(),
  latestLedger: ledgerSequenceSchema.optional(),
});

const rawSimulationErrorSchema = z.object({
  error: z.string().min(1),
});

const rawSimulationSuccessSchema = z.object({
  transactionData: base64XdrSchema,
  minResourceFee: z.string().regex(/^\d+$/, "must be a non-negative integer string"),
  results: z
    .array(
      z.object({
        xdr: z.union([z.literal(""), base64XdrSchema]),
        auth: z.array(base64XdrSchema).optional(),
      })
    )
    .max(1)
    .optional(),
});

// Like the SDK parser, the presence of `error` selects the variant. A
// non-string `error` would make the SDK treat the response as a success with
// no result, so both variants are checked strictly.
export const rawSimulateTransactionResultSchema = z
  .looseObject({ error: z.unknown().optional() })
  .superRefine((result, ctx) => {
    const variant = result.error !== undefined ? rawSimulationErrorSchema : rawSimulationSuccessSchema;
    const parsed = variant.safeParse(result);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      }
    }
  });

export const rawGetLedgerEntriesResultSchema = z.object({
  entries: z
    .array(
      z.object({
        key: base64XdrSchema,
        xdr: base64XdrSchema,
        lastModifiedLedgerSeq: ledgerSequenceSchema.optional(),
        liveUntilLedgerSeq: ledgerSequenceSchema.optional(),
      })
    )
    // Some RPC versions send `null` when nothing matched (=> account not found).
    .nullish(),
});

/**
 * Wire schema per JSON-RPC method. Methods not listed here (for example
 * `getHealth` or `getNetwork`) still get the envelope check and must return
 * a non-null result.
 */
export const rawRpcResultSchemas: Readonly<Record<string, z.ZodType>> = {
  getLatestLedger: rawGetLatestLedgerResultSchema,
  getEvents: rawGetEventsResultSchema,
  simulateTransaction: rawSimulateTransactionResultSchema,
  getLedgerEntries: rawGetLedgerEntriesResultSchema,
};

// ---------------------------------------------------------------------------
// Call-site schemas (SDK-parsed responses)
// ---------------------------------------------------------------------------

export const getLatestLedgerResponseSchema = z.object({
  sequence: ledgerSequenceSchema,
});

// The SDK has already decoded these from XDR; the values themselves are
// checked by the decoder where they are used.
const scValSchema = z.custom<xdr.ScVal>(
  (value) => value !== undefined && value !== null,
  "is required"
);

export const contractEventSchema = z.object({
  id: z.string().min(1),
  txHash: txHashSchema,
  ledger: ledgerSequenceSchema.optional(),
  ledgerClosedAt: ledgerTimestampSchema,
  topic: z.array(scValSchema).optional(),
  value: scValSchema,
  // `Contract` instance once parsed by the SDK.
  contractId: z.unknown().optional(),
});

export const getEventsResponseSchema = z.object({
  events: z.array(contractEventSchema),
  cursor: z.string().optional(),
  latestLedger: ledgerSequenceSchema.optional(),
});

export type ContractEvent = z.infer<typeof contractEventSchema>;
export type GetEventsResponse = z.infer<typeof getEventsResponseSchema>;

// ---------------------------------------------------------------------------
// Contract values (after `scValToNative`)
// ---------------------------------------------------------------------------

/**
 * Token amount in stroops (contract `i128`). Decoded as an exact `bigint`:
 * floats, NaN, strings, negatives and values outside i128 are rejected.
 */
export const stroopAmountSchema = z
  .union([z.bigint(), z.number().int()])
  .transform((value) => BigInt(value))
  .refine((value) => value >= 0n, "must not be negative")
  .refine((value) => value <= I128_MAX, "exceeds the i128 range");

export const positiveStroopAmountSchema = stroopAmountSchema.refine(
  (value) => value > 0n,
  "must be greater than zero"
);

/** Contract `u32` (counts, rounds). Accepts a number or bigint, returns a number. */
export const contractU32Schema = z
  .union([z.number().int(), z.bigint()])
  .transform((value) => BigInt(value))
  .refine((value) => value >= 0n && value <= BigInt(U32_MAX), "must be an unsigned 32-bit integer")
  .transform((value) => Number(value));

export const contractBoolSchema = z.boolean();

/** Soroban `Symbol` as used for project IDs. */
export const contractSymbolSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]{1,32}$/, "must be a contract symbol");

export const payoutAddressSchema = stellarAddressSchema.refine(
  (value) => value.startsWith("G") || value.startsWith("C"),
  "must be an account (G...) or contract (C...) address"
);

/**
 * `payment_sent` data `(recipient, amount)` and `collaborator_claimed` data
 * `(claimer, amount, round)`. Only the first two elements are read; the
 * contract guarantees `amount > 0` for both.
 */
export const payoutEventValueSchema = z.tuple(
  [payoutAddressSchema, positiveStroopAmountSchema],
  z.unknown()
);

/** `distribution_complete` data `(round, total)`; `total` may be zero. */
export const distributionCompleteEventValueSchema = z.tuple(
  [contractU32Schema, stroopAmountSchema],
  z.unknown()
);

/** `get_claimable` return value (`ClaimableInfo`). */
export const claimableInfoSchema = z.looseObject({
  claimed: stroopAmountSchema,
  distribution_round: contractU32Schema,
  last_claim_amount: stroopAmountSchema,
});
