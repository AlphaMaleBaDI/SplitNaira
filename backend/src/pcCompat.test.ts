import { describe, expect, it } from "vitest";
import {
  COMPATIBILITY_MATRIX,
  isVersionSupported,
  parseVersion,
  runSmoke,
  type CompatEntry,
} from "./rpcCompat";

const soroban: CompatEntry = {
  kind: "soroban-rpc",
  provider: "test",
  network: "testnet",
  url: "https://rpc.example.com",
  minVersion: "21.0.0",
};
const horizon: CompatEntry = {
  kind: "horizon",
  provider: "test",
  network: "testnet",
  url: "https://horizon.example.com",
  minVersion: "2.28.0",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function sorobanFetch(version: string, status = "healthy"): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const method = JSON.parse(String(init?.body)).method;
    if (method === "getHealth") return json({ result: { status } });
    return json({ result: { version } });
  }) as typeof fetch;
}

describe("version helpers", () => {
  it("parses plain and prefixed versions", () => {
    expect(parseVersion("21.1.0")).toEqual([21, 1, 0]);
    expect(parseVersion("v2.28.0-abc")).toEqual([2, 28, 0]);
  });
  it("rejects invalid versions", () => {
    expect(parseVersion("nope")).toBeNull();
    expect(isVersionSupported("nope", "1.0.0")).toBe(false);
  });
  it("treats the minimum as inclusive", () => {
    expect(isVersionSupported("21.0.0", "21.0.0")).toBe(true);
    expect(isVersionSupported("20.9.9", "21.0.0")).toBe(false);
    expect(isVersionSupported("21.0.1", "21.0.0")).toBe(true);
  });
});

describe("matrix", () => {
  it("only lists https endpoints", () => {
    for (const e of COMPATIBILITY_MATRIX) expect(e.url.startsWith("https://")).toBe(true);
  });
});

describe("runSmoke", () => {
  it("passes for a healthy Soroban RPC", async () => {
    const [r] = await runSmoke([soroban], { fetchImpl: sorobanFetch("21.4.0") });
    expect(r.ok).toBe(true);
    expect(r.version).toBe("21.4.0");
  });

  it("passes for a Horizon at the minimum version", async () => {
    const fetchImpl = (async () => json({ horizon_version: "2.28.0" })) as typeof fetch;
    const [r] = await runSmoke([horizon], { fetchImpl });
    expect(r.ok).toBe(true);
  });

  it("fails when the version is below the minimum", async () => {
    const [r] = await runSmoke([soroban], { fetchImpl: sorobanFetch("20.0.0") });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("below minimum");
  });

  it("fails when the RPC is unhealthy", async () => {
    const [r] = await runSmoke([soroban], { fetchImpl: sorobanFetch("21.4.0", "unhealthy") });
    expect(r.ok).toBe(false);
  });

  it("fails on HTTP errors", async () => {
    const fetchImpl = (async () => json({}, 500)) as typeof fetch;
    const [r] = await runSmoke([horizon], { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("HTTP 500");
  });

  it("fails when the version is not reported", async () => {
    const fetchImpl = (async () => json({})) as typeof fetch;
    const [r] = await runSmoke([horizon], { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Version not reported");
  });

  it("times out slow endpoints", async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      })) as typeof fetch;
    const [r] = await runSmoke([horizon], { fetchImpl, timeoutMs: 10 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timeout");
  });

  it("rejects non-https endpoints without calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return json({});
    }) as typeof fetch;
    const [r] = await runSmoke([{ ...horizon, url: "http://insecure.example.com" }], { fetchImpl });
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("enforces the endpoint bound", async () => {
    await expect(runSmoke([horizon, horizon, horizon], { maxEndpoints: 2 })).rejects.toThrow(
      RangeError,
    );
  });

  it("allows exactly the maximum number of endpoints", async () => {
    const fetchImpl = (async () => json({ horizon_version: "2.28.0" })) as typeof fetch;
    const results = await runSmoke([horizon, horizon], { fetchImpl, maxEndpoints: 2 });
    expect(results).toHaveLength(2);
  });
});

describe.skipIf(process.env.RPC_COMPAT_LIVE !== "1")("live smoke (opt-in)", () => {
  it("passes against the public matrix", async () => {
    const results = await runSmoke(COMPATIBILITY_MATRIX, { timeoutMs: 10000 });
    for (const r of results) expect(r.ok, `${r.url}: ${r.error}`).toBe(true);
  }, 60000);
});