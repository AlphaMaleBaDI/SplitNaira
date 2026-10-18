import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authEmailRouter } from "../routes/auth-email.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";

const findOneMock = vi.fn();
const sendPasswordResetEmailMock = vi.fn();
const sendInvitationEmailMock = vi.fn();

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => ({
      findOne: findOneMock,
    }),
  }),
}));

vi.mock("../services/session-revocation.js", () => ({
  getSessionVersion: vi.fn(async () => 0),
  getMaxSessionVersionForEmail: vi.fn(async () => 0),
  revokeSessionsForEmail: vi.fn(async () => 1),
}));

vi.mock("../services/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../services/email-provider.js")>("../services/email-provider.js");
  return {
    ...actual,
    getEmailProvider: () => ({
      sendPasswordResetEmail: sendPasswordResetEmailMock,
      sendInvitationEmail: sendInvitationEmailMock,
    }),
  };
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/auth", authEmailRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("Auth Email Flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findOneMock.mockResolvedValue(null);
    sendPasswordResetEmailMock.mockResolvedValue(undefined);
    sendInvitationEmailMock.mockResolvedValue(undefined);
  });

  it("sends password reset email for known user", async () => {
    findOneMock.mockResolvedValue({ email: "known@example.com" });
    const app = createApp();

    const response = await request(app)
      .post("/auth/password-reset/request")
      .send({ email: "known@example.com" });

    expect(response.status).toBe(202);
    expect(sendPasswordResetEmailMock).toHaveBeenCalledTimes(1);
  });

  it("does not send password reset email for unknown user", async () => {
    findOneMock.mockResolvedValue(null);
    const app = createApp();

    const response = await request(app)
      .post("/auth/password-reset/request")
      .send({ email: "unknown@example.com" });

    expect(response.status).toBe(202);
    expect(sendPasswordResetEmailMock).not.toHaveBeenCalled();
  });

  it("confirms password reset token", async () => {
    findOneMock.mockResolvedValue({ email: "known@example.com" });
    const app = createApp();
    const issueRes = await request(app)
      .post("/auth/password-reset/request")
      .send({
        email: "known@example.com",
        resetUrlBase: "https://example.com/reset",
      });

    expect(issueRes.status).toBe(202);
    const args = sendPasswordResetEmailMock.mock.calls[0]?.[0];
    const token = args?.token;

    const confirmRes = await request(app)
      .post("/auth/password-reset/confirm")
      .send({ token, newPassword: "newPassword123" });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.success).toBe(true);
  });

  it("sends invitation email", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/auth/invitations")
      .send({
        email: "invitee@example.com",
        inviterWalletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      });

    expect(response.status).toBe(202);
    expect(sendInvitationEmailMock).toHaveBeenCalledTimes(1);
  });

  it("accepts invitation token", async () => {
    const app = createApp();
    await request(app)
      .post("/auth/invitations")
      .send({ email: "invitee@example.com", inviteUrlBase: "https://example.com/invite" })
      .expect(202);

    const token = sendInvitationEmailMock.mock.calls[0]?.[0]?.token;
    const response = await request(app)
      .post("/auth/invitations/accept")
      .send({ token });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
