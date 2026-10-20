import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import {
  collaborationRouter,
  setProjectDeletionSnapshotResolver,
  setProjectRoleContextResolver,
} from "./collaboration.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import {
  CONFIRMATION_PHRASE,
  resetProjectDeletionAuditForTests,
} from "../services/collaboration/project-deletion.js";
import {
  getInvitationById,
  registerInvitation,
  resetInvitationRegistryForTests,
} from "../services/collaboration/invitation-registry.js";
import { resetOwnershipTransferForTests } from "../services/splits/ownership-transfer.js";
import type { ProjectRoleContext } from "../services/collaboration/permissions.js";

/**
 * Route × persona authorization matrix for the collaboration resource routes.
 *
 * collaboration.test.ts covers one happy path per route and
 * permissions-enforcement.test.ts covers the middleware in isolation. This
 * suite pins the outcome of *every* persona against *every* resource route
 * through the real router, so a regression in any single cell (a new route
 * that forgets a guard, a role that quietly gains a grant) fails loudly.
 *
 * Personas:
 *   anonymous  no X-Stellar-Address header                -> 401
 *   malformed  header that is not a Stellar address       -> 400
 *   owner      project owner
 *   admin / editor / viewer   listed collaborators by role
 *   unrelated  valid address with no role on the project
 *
 * The same table is in docs/authorization-coverage-tests.md.
 */

const PROJECT = "project_1";
const OTHER_PROJECT = "project_2";

type Persona = "anonymous" | "malformed" | "owner" | "admin" | "editor" | "viewer" | "unrelated";

let wallets: Record<Exclude<Persona, "anonymous" | "malformed">, string> & { otherOwner: string };
let contexts: Map<string, ProjectRoleContext>;
let tokenCounter = 0;

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use(requestIdMiddleware);
  a.use("/collaboration", collaborationRouter);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
})();

function as(persona: Persona, req: request.Test): request.Test {
  if (persona === "anonymous") return req;
  if (persona === "malformed") return req.set("X-Stellar-Address", "not-a-stellar-address");
  return req.set("X-Stellar-Address", wallets[persona]);
}

function inviteBody() {
  tokenCounter += 1;
  return { email: `person${tokenCounter}@example.com`, tokenJti: `jti-${tokenCounter}` };
}

/** A fresh pending invitation on PROJECT, sent by the admin collaborator. */
function pendingInvitation(): string {
  return registerInvitation({ ...inviteBody(), projectId: PROJECT, inviterWalletAddress: wallets.admin }).id;
}

const deleteBody = { confirmed: true, confirmationText: CONFIRMATION_PHRASE };

beforeEach(() => {
  wallets = {
    owner: Keypair.random().publicKey(),
    admin: Keypair.random().publicKey(),
    editor: Keypair.random().publicKey(),
    viewer: Keypair.random().publicKey(),
    unrelated: Keypair.random().publicKey(),
    otherOwner: Keypair.random().publicKey(),
  };
  contexts = new Map([
    [
      PROJECT,
      {
        owner: wallets.owner,
        collaborators: [
          { address: wallets.admin, role: "admin" },
          { address: wallets.editor, role: "editor" },
          { address: wallets.viewer, role: "viewer" },
        ],
      },
    ],
    [OTHER_PROJECT, { owner: wallets.otherOwner, collaborators: [] }],
  ]);
  resetInvitationRegistryForTests();
  resetOwnershipTransferForTests();
  resetProjectDeletionAuditForTests();
  setProjectRoleContextResolver(async (projectId) => contexts.get(projectId) ?? null);
  setProjectDeletionSnapshotResolver(async (projectId) => ({
    projectId,
    hasDeposits: true,
    hasDistributions: false,
    hasClaims: false,
    transactionCount: 1,
  }));
});

// ─────────────────────────────────────────────────────────────────────────────
// The matrix
// ─────────────────────────────────────────────────────────────────────────────

interface RouteCase {
  route: string;
  send: (persona: Persona) => request.Test;
  expected: Record<Persona, number>;
  /** Asserted on denied (403) responses. */
  deniedError?: string;
}

const ROUTES: RouteCase[] = [
  {
    route: "POST /collaboration/projects/:projectId/delete",
    send: (p) => as(p, request(app).post(`/collaboration/projects/${PROJECT}/delete`)).send(deleteBody),
    expected: { anonymous: 401, malformed: 400, owner: 200, admin: 403, editor: 403, viewer: 403, unrelated: 403 },
    deniedError: "permission_denied",
  },
  {
    route: "POST /collaboration/projects/:projectId/invitations",
    send: (p) => as(p, request(app).post(`/collaboration/projects/${PROJECT}/invitations`)).send(inviteBody()),
    expected: { anonymous: 401, malformed: 400, owner: 201, admin: 201, editor: 403, viewer: 403, unrelated: 403 },
    deniedError: "permission_denied",
  },
  {
    route: "POST /collaboration/invitations/:invitationId/cancel",
    send: (p) => as(p, request(app).post(`/collaboration/invitations/${pendingInvitation()}/cancel`)).send({}),
    // admin is the inviter; owner cancels via project-owner authority.
    expected: { anonymous: 401, malformed: 400, owner: 200, admin: 200, editor: 403, viewer: 403, unrelated: 403 },
    deniedError: "forbidden_not_inviter",
  },
  {
    route: "POST /collaboration/projects/:projectId/transfer-ownership",
    send: (p) =>
      as(p, request(app).post(`/collaboration/projects/${PROJECT}/transfer-ownership`)).send({
        newOwner: Keypair.random().publicKey(),
      }),
    expected: { anonymous: 401, malformed: 400, owner: 200, admin: 403, editor: 403, viewer: 403, unrelated: 403 },
    deniedError: "forbidden_not_owner",
  },
];

const PERSONAS: Persona[] = ["anonymous", "malformed", "owner", "admin", "editor", "viewer", "unrelated"];

describe.each(ROUTES)("$route", ({ send, expected, deniedError }) => {
  it.each(PERSONAS)("%s", async (persona) => {
    const res = await send(persona);
    expect(res.status).toBe(expected[persona]);
    if (res.status === 403 && deniedError) expect(res.body.error).toBe(deniedError);
    if (res.status === 401 || res.status === 400) {
      // Rejected before the handler: no role or project data may leak.
      expect(JSON.stringify(res.body)).not.toContain(wallets.owner);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public routes (intentionally unauthenticated)
// ─────────────────────────────────────────────────────────────────────────────

describe("public routes", () => {
  it.each(PERSONAS)("GET /collaboration/permissions/matrix is readable by %s", async (persona) => {
    const res = await as(persona, request(app).get("/collaboration/permissions/matrix"));
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r: { role: string }) => r.role)).toEqual(["owner", "admin", "editor", "viewer"]);
  });

  it("POST /collaboration/invitations/accept authorizes by token possession, not identity", async () => {
    const { tokenJti } = registerInvitation({ ...inviteBody(), projectId: PROJECT, inviterWalletAddress: wallets.admin });
    const res = await request(app).post("/collaboration/invitations/accept").send({ tokenJti });
    expect(res.status).toBe(200);
    expect(res.body.invitation.status).toBe("accepted");
  });

  it("accepting an unknown token fails without revealing other invitations", async () => {
    pendingInvitation();
    const res = await request(app).post("/collaboration/invitations/accept").send({ tokenJti: "guess" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain("@example.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary cases
// ─────────────────────────────────────────────────────────────────────────────

describe("authorization boundaries", () => {
  it("ignores a client-supplied role or owner in the body", async () => {
    const res = await as("viewer", request(app).post(`/collaboration/projects/${PROJECT}/delete`)).send({
      ...deleteBody,
      role: "owner",
      actor: wallets.owner,
      owner: wallets.viewer,
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "permission_denied", role: "viewer" });
  });

  it("does not let the owner of one project act on another (no cross-project access)", async () => {
    const del = await as("owner", request(app).post(`/collaboration/projects/${OTHER_PROJECT}/delete`)).send(deleteBody);
    expect(del.status).toBe(403);
    expect(del.body.reason).toBe("project_role_unknown");

    const transfer = await as("owner", request(app).post(`/collaboration/projects/${OTHER_PROJECT}/transfer-ownership`)).send({
      newOwner: wallets.owner,
    });
    expect(transfer.status).toBe(403);
  });

  it("fails closed for an unknown project instead of granting a default role", async () => {
    const res = await as("owner", request(app).post("/collaboration/projects/ghost/invitations")).send(inviteBody());
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("project_role_unknown");
  });

  it("fails closed when the role authority throws", async () => {
    setProjectRoleContextResolver(async () => {
      throw new Error("db down");
    });
    const res = await as("owner", request(app).post(`/collaboration/projects/${PROJECT}/delete`)).send(deleteBody);
    expect(res.status).toBe(403);
  });

  it("treats a collaborator listed without a role as a viewer", async () => {
    const roleless = Keypair.random().publicKey();
    contexts.get(PROJECT)!.collaborators.push({ address: roleless });
    const res = await request(app)
      .post(`/collaboration/projects/${PROJECT}/invitations`)
      .set("X-Stellar-Address", roleless)
      .send(inviteBody());
    expect(res.status).toBe(403);
    expect(res.body.role).toBe("viewer");
  });

  it("keeps the owner as owner even if also listed as a viewer", async () => {
    contexts.get(PROJECT)!.collaborators.push({ address: wallets.owner, role: "viewer" });
    const res = await as("owner", request(app).post(`/collaboration/projects/${PROJECT}/delete`)).send(deleteBody);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");
  });

  it("accepts the owner's address with surrounding whitespace as the same identity", async () => {
    const res = await request(app)
      .post(`/collaboration/projects/${PROJECT}/delete`)
      .set("X-Stellar-Address", `  ${wallets.owner}  `)
      .send(deleteBody);
    expect(res.status).toBe(200);
  });

  it("rejects a lower-cased owner address instead of matching it", async () => {
    const res = await request(app)
      .post(`/collaboration/projects/${PROJECT}/delete`)
      .set("X-Stellar-Address", wallets.owner.toLowerCase())
      .send(deleteBody);
    expect(res.status).toBe(400);
  });

  it("revokes the previous owner's transfer right after a transfer", async () => {
    const next = Keypair.random().publicKey();
    await as("owner", request(app).post(`/collaboration/projects/${PROJECT}/transfer-ownership`))
      .send({ newOwner: next })
      .expect(200);
    const again = await as("owner", request(app).post(`/collaboration/projects/${PROJECT}/transfer-ownership`)).send({
      newOwner: Keypair.random().publicKey(),
    });
    expect(again.status).toBe(403);
    expect(again.body.error).toBe("forbidden_not_owner");
  });

  it("a denied cancel leaves the invitation pending", async () => {
    const id = pendingInvitation();
    await as("unrelated", request(app).post(`/collaboration/invitations/${id}/cancel`)).send({}).expect(403);
    expect(getInvitationById(id)?.status).toBe("pending");
  });

  it("records the authenticated inviter, never a body-supplied one", async () => {
    const res = await as("admin", request(app).post(`/collaboration/projects/${PROJECT}/invitations`)).send({
      ...inviteBody(),
      inviterWalletAddress: wallets.unrelated,
    });
    expect(res.status).toBe(201);
    expect(res.body.invitation.inviterWalletAddress).toBe(wallets.admin);
  });
});
