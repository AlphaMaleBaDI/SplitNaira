import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * Contract events as an integration contract.
 *
 * The backend decodes `payment_sent`, `collaborator_claimed` and
 * `distribution_complete` positionally, so the committed snapshot in
 * contracts/interface/events.contract.json must match contracts/events.rs and
 * every change must be classified before it ships. See docs/contract-events.md.
 */

const repoUrl = new URL("../../../", import.meta.url);
const libUrl = new URL("contracts/scripts/event-contract.mjs", repoUrl);
const cliPath = fileURLToPath(new URL("contracts/scripts/check-event-contract.mjs", repoUrl));
const eventsSource = readFileSync(new URL("contracts/events.rs", repoUrl), "utf8");
const snapshot = JSON.parse(
  readFileSync(new URL("contracts/interface/events.contract.json", repoUrl), "utf8")
);

type WireValue = { position: number; kind: "symbol" | "field"; type: string; value?: string; field?: string };
type EventShape = {
  struct: string;
  topics: WireValue[];
  data: { shape: "unit" | "single" | "tuple"; fields: WireValue[] };
};
type Events = Record<string, EventShape>;
type Diff = { level: string; changes: Array<{ level: string; event: string; message: string }> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lib: any;

beforeAll(async () => {
  lib = await import(libUrl.href);
});

const clone = <T>(value: T): T => structuredClone(value);
const baseEvents = (): Events => clone(snapshot.events as Events);
const levels = (diff: Diff) => diff.changes.map((c) => c.level);

function rustEvent(body: string, structFields = "pub project_id: Symbol, pub amount: i128,") {
  return `use soroban_sdk::{Env, Symbol};
pub struct Sample { ${structFields} }
impl Publishable for Sample {
    fn publish(&self, env: &Env) {
        env.events().publish(${body});
    }
}`;
}

describe("event contract snapshot", () => {
  it("matches the events currently published by contracts/events.rs", () => {
    expect(lib.extractEventContract(eventsSource)).toEqual(snapshot.events);
  });

  it("is a valid versioned snapshot", () => {
    expect(snapshot.schema).toBe(lib.EVENT_CONTRACT_SCHEMA);
    expect(() => lib.parseVersion(snapshot.version)).not.toThrow();
    expect(Object.keys(snapshot.events).length).toBeGreaterThan(0);
  });

  it("covers every publish call, including inherent impls", () => {
    const publishCalls = eventsSource
      .slice(0, eventsSource.indexOf("#[cfg(test)]"))
      .match(/env\.events\(\)\.publish/g);
    expect(Object.keys(snapshot.events)).toHaveLength(publishCalls?.length ?? 0);
    expect(snapshot.events.accounting_discrepancy.struct).toBe("AccountingDiscrepancy");
  });

  it("keeps topic[0] equal to the event name for every event", () => {
    for (const [name, event] of Object.entries(snapshot.events as Events)) {
      expect(event.topics[0]).toMatchObject({ position: 0, kind: "symbol", value: name });
    }
  });

  describe("backend consumer alignment", () => {
    // Mirrors backend/src/schemas/stellar-rpc.schemas.ts tuple schemas and the
    // EventListenerService topic filters (topic[1] = project id symbol).
    it.each([
      ["payment_sent", ["Address", "i128"]],
      ["collaborator_claimed", ["Address", "i128"]],
      ["distribution_complete", ["u32", "i128"]],
    ])("%s data starts with %j and topic[1] is the project id", (name, prefix) => {
      const event = (snapshot.events as Events)[name];
      expect(event.data.shape).toBe("tuple");
      expect(event.data.fields.slice(0, prefix.length).map((f) => f.type)).toEqual(prefix);
      expect(event.topics[1]).toMatchObject({ kind: "field", type: "Symbol" });
    });
  });
});

describe("extractEventContract", () => {
  it("models single, tuple and unit data", () => {
    const single = lib.extractEventContract(rustEvent(`(Symbol::new(env, "a"), self.project_id.clone()), self.amount`));
    expect(single.a.data).toEqual({
      shape: "single",
      fields: [{ position: 0, kind: "field", field: "amount", type: "i128" }],
    });

    const tuple = lib.extractEventContract(rustEvent(`(Symbol::new(env, "b"),), (self.project_id.clone(), self.amount)`));
    expect(tuple.b.data.shape).toBe("tuple");
    expect(tuple.b.data.fields.map((f: WireValue) => f.type)).toEqual(["Symbol", "i128"]);

    const unit = lib.extractEventContract(rustEvent(`(Symbol::new(env, "c"), self.project_id.clone()), ()`));
    expect(unit.c.data).toEqual({ shape: "unit", fields: [] });
  });

  it("supports symbol_short! and ignores comments and test modules", () => {
    const source = `${rustEvent(`(symbol_short!("short"), /* id */ self.project_id.clone()), self.amount // amt`)}
#[cfg(test)]
mod tests { impl Publishable for Sample { fn publish(&self, env: &Env) { env.events().publish((Symbol::new(env, "ignored"),), ()); } } }`;
    expect(Object.keys(lib.extractEventContract(source))).toEqual(["short"]);
  });

  it.each([
    ["computed data", rustEvent(`(Symbol::new(env, "x"),), self.amount * 2`), /unsupported event expression/],
    ["unknown field", rustEvent(`(Symbol::new(env, "x"),), self.missing`), /unknown field self\.missing/],
    ["non-symbol topic[0]", rustEvent(`(self.project_id.clone(),), self.amount`), /topic\[0\] must be a Symbol/],
    ["wrong arity", rustEvent(`(Symbol::new(env, "x"),)`), /publish expects \(topics, data\)/],
    ["no events", "pub struct Empty { pub a: u32 }", /No Publishable events found/],
  ])("fails loudly on %s", (_label, source, error) => {
    expect(() => lib.extractEventContract(source)).toThrow(error);
  });

  it("rejects duplicate event names", () => {
    const one = rustEvent(`(Symbol::new(env, "dup"),), self.amount`);
    const two = one.replace(/Sample/g, "Other");
    expect(() => lib.extractEventContract(`${one}\n${two}`)).toThrow(/Duplicate event name "dup"/);
  });
});

describe("diffEventContracts", () => {
  it("reports no changes for identical contracts", () => {
    expect(lib.diffEventContracts(baseEvents(), baseEvents())).toEqual({ level: "none", changes: [] });
  });

  const breakingCases: Array<[string, (e: Events) => void, RegExp]> = [
    ["event removed", (e) => delete e.payment_sent, /event removed/],
    ["topic retyped", (e) => { e.payment_sent.topics[1].type = "Address"; }, /topic\[1\] changed Symbol -> Address/],
    [
      "topic appended",
      (e) => { e.payment_sent.topics.push({ position: 2, kind: "field", field: "round", type: "u32" }); },
      /topic\[2\] \(u32\) added/,
    ],
    ["topic removed", (e) => { e.payment_sent.topics.pop(); }, /topic\[1\] \(Symbol\) removed/],
    ["data reordered", (e) => { e.payment_sent.data.fields.reverse(); }, /data\[0\] changed Address -> i128/],
    ["data field removed", (e) => { e.deposit_received.data.fields.pop(); }, /data\[2\] \(i128\) removed/],
    ["data retyped", (e) => { e.distribution_complete.data.fields[0].type = "u64"; }, /data\[0\] changed u32 -> u64/],
    ["single -> tuple", (e) => { e.project_created.data.shape = "tuple"; }, /data shape changed single -> tuple/],
    ["tuple -> unit", (e) => { e.payment_sent.data = { shape: "unit", fields: [] }; }, /data shape changed tuple -> unit/],
  ];

  it.each(breakingCases)("classifies %s as breaking", (_label, mutate, message) => {
    const head = baseEvents();
    mutate(head);
    const diff: Diff = lib.diffEventContracts(baseEvents(), head);
    expect(diff.level).toBe("breaking");
    expect(diff.changes.some((c) => c.level === "breaking" && message.test(c.message))).toBe(true);
  });

  it("treats a renamed topic[0] as a removal plus a new event", () => {
    const head = baseEvents();
    head.payout_sent = head.payment_sent;
    delete head.payment_sent;
    const diff: Diff = lib.diffEventContracts(baseEvents(), head);
    expect(diff.level).toBe("breaking");
    expect(levels(diff).sort()).toEqual(["additive", "breaking"]);
  });

  it("classifies a new event as additive", () => {
    const head = baseEvents();
    head.brand_new = clone(head.project_locked);
    const diff: Diff = lib.diffEventContracts(baseEvents(), head);
    expect(diff).toEqual({ level: "additive", changes: [{ level: "additive", event: "brand_new", message: "new event" }] });
  });

  it("classifies a trailing tuple field as additive", () => {
    const head = baseEvents();
    head.payment_sent.data.fields.push({ position: 2, kind: "field", field: "round", type: "u32" });
    const diff: Diff = lib.diffEventContracts(baseEvents(), head);
    expect(diff.level).toBe("additive");
    expect(diff.changes[0].message).toMatch(/data\[2\] \(u32\) appended/);
  });

  it("classifies wire-identical renames as informational", () => {
    const head = baseEvents();
    head.payment_sent.struct = "PayoutSent";
    head.payment_sent.data.fields[1].field = "amount_stroops";
    head.payment_sent.topics[1].field = "id";
    const diff: Diff = lib.diffEventContracts(baseEvents(), head);
    expect(diff.level).toBe("informational");
    expect(levels(diff)).toEqual(["informational", "informational", "informational"]);
  });

  it("reports the most severe level when changes are mixed", () => {
    const head = baseEvents();
    head.brand_new = clone(head.project_locked);
    head.payment_sent.struct = "Renamed";
    delete head.project_created;
    expect(lib.diffEventContracts(baseEvents(), head).level).toBe("breaking");
  });
});

describe("versioning", () => {
  it.each([
    ["breaking", "1.4.2", "2.0.0"],
    ["additive", "1.4.2", "1.5.0"],
    ["informational", "1.4.2", "1.4.3"],
    ["none", "1.4.2", "1.4.2"],
  ])("bumps %s changes from %s to %s", (level, from, to) => {
    expect(lib.bumpVersion(from, level)).toBe(to);
  });

  it.each([
    ["1.0.0", "2.0.0", "breaking", null],
    ["1.0.0", "1.1.0", "breaking", /require a MAJOR bump/],
    ["1.0.0", "1.0.0", "breaking", /require a MAJOR bump/],
    ["1.2.0", "1.3.0", "additive", null],
    ["1.2.0", "2.0.0", "additive", null],
    ["1.2.0", "1.2.0", "additive", /at least a MINOR bump/],
    ["1.2.0", "1.2.1", "informational", null],
    ["1.2.0", "1.2.0", "informational", /bump at least PATCH/],
    ["1.2.0", "1.2.0", "none", null],
    ["2.0.0", "1.9.9", "none", /version went backwards/],
  ])("checkVersionBump(%s -> %s, %s)", (base, head, level, expected) => {
    const result = lib.checkVersionBump(base, head, level);
    if (expected === null) expect(result).toBeNull();
    else expect(result).toMatch(expected as RegExp);
  });

  it.each(["1.0", "v1.0.0", "1.0.0-beta", ""])("rejects malformed version %j", (version) => {
    expect(() => lib.parseVersion(version)).toThrow(/Invalid event contract version/);
  });
});

describe("check-event-contract CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "event-contract-"));
  const run = (...args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  const writeBase = (name: string, mutate: (s: typeof snapshot) => void) => {
    const base = clone(snapshot);
    mutate(base);
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(base));
    return path;
  };

  it("passes when source matches the committed snapshot", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/matches event contract/);
  });

  it("treats a missing base snapshot as first adoption", () => {
    expect(run("--base", join(dir, "does-not-exist.json")).status).toBe(0);
  });

  it("passes when the base snapshot is identical", () => {
    expect(run("--base", writeBase("same.json", () => {})).status).toBe(0);
  });

  it("fails when a breaking change ships without a MAJOR bump", () => {
    // Base had an extra event that head no longer emits, at the same version.
    const path = writeBase("breaking.json", (s) => {
      s.events.legacy_event = clone(s.events.project_locked);
    });
    const result = run("--base", path);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/\[breaking\] legacy_event: event removed/);
    expect(result.stderr).toMatch(/require a MAJOR bump/);
  });

  it("accepts the same breaking change when head is a MAJOR bump ahead", () => {
    const [major] = lib.parseVersion(snapshot.version);
    expect(major).toBeGreaterThan(0);
    const path = writeBase("breaking-bumped.json", (s) => {
      s.events.legacy_event = clone(s.events.project_locked);
      s.version = `${major - 1}.9.9`;
    });
    const result = run("--base", path);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Version bump matches/);
  });

  it("exits 2 on a malformed base snapshot", () => {
    const path = join(dir, "bad-schema.json");
    writeFileSync(path, JSON.stringify({ schema: "something-else", version: "1.0.0", events: {} }));
    expect(run("--base", path).status).toBe(2);
  });
});
