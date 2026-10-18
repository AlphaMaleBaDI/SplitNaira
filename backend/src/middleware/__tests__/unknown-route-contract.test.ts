import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { notFoundHandler } from "../error.js";
import { requestIdMiddleware } from "../request-id.js";

/**
 * Issue #1460: the unknown-route (catch-all) response is a stable,
 * machine-readable 404. These tests pin the contract so a future change can't
 * silently leak routing detail or make the body attacker-controllable.
 */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.get("/known", (_req, res) => res.json({ ok: true }));
  app.use(notFoundHandler);
  return app;
}

const UNKNOWN_MESSAGE = "The requested resource does not exist.";

describe("Issue #1460: unknown-route response contract", () => {
  it("returns the stable machine-readable 404 for an unknown GET route", async () => {
    const res = await request(createTestApp()).get("/definitely-not-a-route");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({
      error: "not_found",
      code: "NOT_FOUND",
      message: UNKNOWN_MESSAGE,
      requestId: expect.any(String),
      details: {},
    });
  });

  it("is stable across methods and paths (no request echo)", async () => {
    const app = createTestApp();

    const getRes = await request(app).get("/definitely-not-a-route?secret=abc");
    const postRes = await request(app).post("/another/missing/path").send({ secret: "abc" });
    const deleteRes = await request(app).delete("/v2/internal/unknown");

    for (const res of [getRes, postRes, deleteRes]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
      expect(res.body.code).toBe("NOT_FOUND");
      expect(res.body.message).toBe(UNKNOWN_MESSAGE);
      expect(res.body.details).toEqual({});
    }

    // No reflection of caller-controlled path, query, body or method.
    const serialized = JSON.stringify([getRes.body, postRes.body, deleteRes.body]);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("internal");
    expect(serialized).not.toContain("another");
  });

  it("never exposes stack traces or internal routing details", async () => {
    const res = await request(createTestApp()).get("/boom/<script>alert(1)</script>");

    const serialized = JSON.stringify(res.body);
    expect(res.body.error).toBe("not_found");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("Route not found");
    expect(serialized).not.toContain("<script>");
    expect(serialized).not.toContain("/boom");
  });

  it("carries a non-empty requestId in the body and the response header", async () => {
    const res = await request(createTestApp()).get("/missing");

    expect(res.body.requestId).toBeTruthy();
    expect(res.body.requestId.length).toBeGreaterThan(0);
    expect(res.headers["x-request-id"]).toBe(res.body.requestId);
  });

  it("propagates an inbound correlation id", async () => {
    const res = await request(createTestApp())
      .get("/missing")
      .set("x-correlation-id", "corr-unknown-route");

    expect(res.status).toBe(404);
    expect(res.body.requestId).toBe("corr-unknown-route");
  });

  it("does not shadow known routes", async () => {
    const res = await request(createTestApp()).get("/known");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
