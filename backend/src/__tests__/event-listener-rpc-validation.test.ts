/**
 * Issue #1494: EventListenerService fails closed on malformed RPC data.
 *
 * The listener turns `payment_sent` / `collaborator_claimed` events into
 * `completed` transaction rows and advances a persisted cursor. A malformed
 * response, or a single malformed payout event, must record nothing and
 * leave the cursor where it was, so the batch is retried rather than
 * half-recorded or skipped. Uses real Stellar SDK values; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Address, Contract, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const OTHER_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 9));
const I128_MAX = (1n << 127n) - 1n;

const mocks = vi.hoisted(() => {
  const manager = { upsert: vi.fn(async () => undefined) };
  return {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn(),
    manager,
    transaction: vi.fn(async (work: (m: typeof manager) => Promise<void>) => work(manager)),
    repo: {
      findOneBy: vi.fn(async () => null),
      create: vi.fn((record: Record<string, unknown>) => record),
    },
    publishSseEvent: vi.fn(),
  };
});

vi.mock("../services/stellar.js", () => ({
  getStellarRpcServer: () => ({ getEvents: mocks.getEvents, getLatestLedger: mocks.getLatestLedger }),
  executeWithRetry: <T>(fn: () => Promise<T>) => fn(),
  loadStellarConfig: () => ({ contractId: CONTRACT_ID }),
}));

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => mocks.repo,
    transaction: mocks.transaction,
  }),
}));

vi.mock("../services/splits.service.js", () => ({
  fetchProjectById: vi.fn(async () => ({ token: CONTRACT_ID })),
}));

vi.mock("../services/SseEventBus.js", () => ({ publishSseEvent: mocks.publishSseEvent }));

vi.mock("../services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type ListenerModule = typeof import("../services/EventListenerService.js");

const symbol = (value: string) => nativeToScVal(value, { type: "symbol" });
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

function payoutEvent(overrides: {
  name?: string;
  txHash?: string;
  projectId?: xdr.ScVal;
  recipient?: xdr.ScVal;
  amount?: xdr.ScVal;
  extraValues?: xdr.ScVal[];
  contractId?: string;
  ledgerClosedAt?: string;
} = {}) {
  const recipient = overrides.recipient ?? Address.fromString(Keypair.random().publicKey()).toScVal();
  return {
    id: "0000004294967296-0000000001",
    type: "contract",
    ledger: 1234,
    ledgerClosedAt: overrides.ledgerClosedAt ?? "2026-04-01T10:00:00Z",
    txHash: overrides.txHash ?? "ab".repeat(32),
    contractId: new Contract(overrides.contractId ?? CONTRACT_ID),
    topic: [symbol(overrides.name ?? "payment_sent"), overrides.projectId ?? symbol("proj_1")],
    value: xdr.ScVal.scvVec([recipient, overrides.amount ?? i128(6_000_000n), ...(overrides.extraValues ?? [])]),
    inSuccessfulContractCall: true,
  };
}

function page(events: unknown[], extra: Record<string, unknown> = {}) {
  return { events, cursor: "cursor-2", latestLedger: 1300, ...extra };
}

let mod: ListenerModule;

async function freshListener(): Promise<ListenerModule> {
  vi.resetModules();
  const listener = await import("../services/EventListenerService.js");
  mocks.getLatestLedger.mockResolvedValue({ sequence: 1300 });
  await listener.startEventListenerService();
  return listener;
}

function upsertedTransactions(): Array<Record<string, unknown>> {
  return mocks.manager.upsert.mock.calls
    .filter(([entity]) => (entity as { name?: string }).name === "TransactionRecord")
    .flatMap(([, rows]) => rows as Array<Record<string, unknown>>);
}

function persistedCursor(): unknown {
  const call = mocks.manager.upsert.mock.calls.find(
    ([, row]) => (row as { key?: string }).key === "event_listener_cursor"
  );
  return (call?.[1] as { value?: unknown } | undefined)?.value;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getEvents.mockReset();
  mocks.getLatestLedger.mockReset();
  mod = await freshListener();
});

afterEach(() => {
  mod.stopEventListenerService();
});

describe("EventListenerService - valid payout events (#1494)", () => {
  it("records a payment_sent event with exact amount, recipient and timestamp", async () => {
    const recipient = Keypair.random().publicKey();
    mocks.getEvents.mockResolvedValue(
      page([payoutEvent({ recipient: Address.fromString(recipient).toScVal(), amount: i128(I128_MAX) })])
    );

    await mod.pollEvents();

    expect(upsertedTransactions()).toEqual([
      expect.objectContaining({
        roundId: "proj_1",
        recipient,
        amount: I128_MAX.toString(),
        txHash: "ab".repeat(32),
        timestamp: Date.parse("2026-04-01T10:00:00Z") / 1000,
        status: "completed",
      }),
    ]);
    expect(persistedCursor()).toBe("cursor-2");
    expect(mod.getServiceHealth().consecutiveErrors).toBe(0);
  });

  it("records a collaborator_claimed event to a contract address with a trailing round", async () => {
    mocks.getEvents.mockResolvedValue(
      page([
        payoutEvent({
          name: "collaborator_claimed",
          recipient: Address.fromString(OTHER_CONTRACT_ID).toScVal(),
          amount: i128(1n),
          extraValues: [nativeToScVal(3, { type: "u32" })],
        }),
      ])
    );

    await mod.pollEvents();

    expect(upsertedTransactions()).toEqual([
      expect.objectContaining({ recipient: OTHER_CONTRACT_ID, amount: "1" }),
    ]);
  });

  it("accepts an empty page and still advances the cursor", async () => {
    mocks.getEvents.mockResolvedValue(page([]));

    await mod.pollEvents();

    expect(upsertedTransactions()).toEqual([]);
    expect(persistedCursor()).toBe("cursor-2");
    expect(mod.getLedgerLag()).toMatchObject({ latestLedger: 1300, lastProcessedLedger: 1300, lag: 0 });
  });

  it("tolerates unknown extra fields on the response and events", async () => {
    mocks.getEvents.mockResolvedValue(
      page([{ ...payoutEvent(), someNewRpcField: { nested: true } }], { oldestLedger: 1, newTopLevelField: "x" })
    );

    await mod.pollEvents();

    expect(upsertedTransactions()).toHaveLength(1);
  });

  it("ignores events that are not payouts without failing the batch", async () => {
    mocks.getEvents.mockResolvedValue(
      page([
        { ...payoutEvent({ name: "deposit_received" }), value: nativeToScVal("anything") },
        payoutEvent(),
      ])
    );

    await mod.pollEvents();

    expect(upsertedTransactions()).toHaveLength(1);
    expect(mod.getServiceHealth().consecutiveErrors).toBe(0);
  });
});

describe("EventListenerService - fails closed on malformed RPC data (#1494)", () => {
  const malformedResponses: Array<[string, unknown]> = [
    ["a null response", null],
    ["a response without events but with a cursor", { cursor: "cursor-2", latestLedger: 1300 }],
    ["events that is not an array", { events: "nope", cursor: "cursor-2" }],
    ["a non-integer latestLedger", page([payoutEvent()], { latestLedger: "1300" })],
    ["an event with a malformed txHash", page([payoutEvent({ txHash: "TX1" })])],
    ["an event with a malformed ledgerClosedAt", page([payoutEvent({ ledgerClosedAt: "not a date" })])],
    ["an event without a value", page([{ ...payoutEvent(), value: undefined }])],
  ];

  const malformedPayouts: Array<[string, ReturnType<typeof payoutEvent>]> = [
    ["a zero amount", payoutEvent({ amount: i128(0n) })],
    ["a negative amount", payoutEvent({ amount: i128(-5n) })],
    ["a non-integer amount type", payoutEvent({ amount: nativeToScVal("6000000", { type: "string" }) })],
    ["a recipient that is not an address", payoutEvent({ recipient: nativeToScVal("GABC", { type: "string" }) })],
    ["a missing amount", { ...payoutEvent(), value: xdr.ScVal.scvVec([Address.fromString(Keypair.random().publicKey()).toScVal()]) }],
    ["a project topic that is not a symbol", payoutEvent({ projectId: nativeToScVal("bad project id!", { type: "string" }) })],
    ["an event from a different contract", payoutEvent({ contractId: OTHER_CONTRACT_ID })],
    ["an event with no contract id", { ...payoutEvent(), contractId: undefined }],
  ];

  async function expectNothingRecorded() {
    await mod.pollEvents();

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.manager.upsert).not.toHaveBeenCalled();
    expect(mocks.publishSseEvent).not.toHaveBeenCalled();
    expect(mod.getServiceHealth().consecutiveErrors).toBe(1);
    expect(mod.getLedgerLag().latestLedger).toBeNull();
  }

  for (const [label, response] of malformedResponses) {
    it(`records nothing and keeps the cursor for ${label}`, async () => {
      mocks.getEvents.mockResolvedValue(response);
      await expectNothingRecorded();
    });
  }

  for (const [label, event] of malformedPayouts) {
    it(`records nothing and keeps the cursor for a payout with ${label}`, async () => {
      mocks.getEvents.mockResolvedValue(page([event]));
      await expectNothingRecorded();
    });
  }

  it("does not record the valid events of a batch that contains one malformed payout", async () => {
    mocks.getEvents.mockResolvedValue(page([payoutEvent(), payoutEvent({ amount: i128(-1n) })]));
    await expectNothingRecorded();
  });

  it("retries the same position on the next poll and records once the data is valid", async () => {
    mocks.getEvents.mockResolvedValueOnce(page([payoutEvent({ amount: i128(-1n) })]));
    await mod.pollEvents();
    const firstRequest = mocks.getEvents.mock.calls[0][0];

    mocks.getEvents.mockResolvedValueOnce(page([payoutEvent()]));
    await mod.pollEvents();

    // Same start position both times: the bad batch did not move the cursor.
    expect(mocks.getEvents.mock.calls[1][0]).toEqual(firstRequest);
    expect(upsertedTransactions()).toHaveLength(1);
    expect(mod.getServiceHealth().consecutiveErrors).toBe(0);
  });
});

describe("EventListenerService - getLatestLedger validation (#1494)", () => {
  it("does not derive a start ledger from a malformed getLatestLedger response", async () => {
    mod.stopEventListenerService();
    vi.resetModules();
    const listener = await import("../services/EventListenerService.js");
    mocks.getLatestLedger.mockResolvedValue({ sequence: "1300" });
    mocks.getEvents.mockResolvedValue(page([]));

    await listener.startEventListenerService();
    await listener.pollEvents();

    // Falls back to polling from the RPC's default position instead of a
    // start ledger computed from garbage.
    expect(mocks.getEvents.mock.calls[0][0]).not.toHaveProperty("startLedger");
    listener.stopEventListenerService();
  });
});
