import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient, ApiError } from "../lib/api-client";

const payload = {
  owner: "GOWNER",
  projectId: "p1",
  title: "Project",
  projectType: "music",
  token: "CTOKEN",
  collaborators: [
    { address: "GA", alias: "A", basisPoints: 5000 },
    { address: "GB", alias: "B", basisPoints: 5000 },
  ],
};

const okResponse = {
  ok: true,
  status: 200,
  json: async () => ({ xdr: "XDR", metadata: { networkPassphrase: "TESTNET", contractId: "CID" } }),
} as Response;

function sentHeaders(): Record<string, string> {
  const [, init] = vi.mocked(fetch).mock.calls[0];
  return (init?.headers ?? {}) as Record<string, string>;
}

describe("buildCreateSplitXdr Idempotency-Key (#1266)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("sends the Idempotency-Key header when a key is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse);

    await new ApiClient("https://api.test").buildCreateSplitXdr(payload, { idempotencyKey: "key-123" });

    expect(sentHeaders()).toMatchObject({ "Idempotency-Key": "key-123", "Content-Type": "application/json" });
  });

  it("omits the header when no key is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse);

    await new ApiClient("https://api.test").buildCreateSplitXdr(payload);

    expect(sentHeaders()).not.toHaveProperty("Idempotency-Key");
  });

  it("surfaces a 409 payload mismatch as an ApiError with the conflict code, without retrying", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: "idempotency_key_conflict",
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message: "Idempotency-Key was already used with a different request payload.",
      }),
    } as Response);

    const error = await new ApiClient("https://api.test")
      .buildCreateSplitXdr(payload, { idempotencyKey: "key-123" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe("idempotency_key_conflict");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
