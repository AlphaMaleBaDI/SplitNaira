import crypto from "crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import { logger } from "./logger.js";

const EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || process.env.JWT_SECRET || "dev-email-secret";
const PASSWORD_RESET_TOKEN_TTL = (process.env.PASSWORD_RESET_TOKEN_TTL || "30m") as SignOptions["expiresIn"];
const INVITATION_TOKEN_TTL = (process.env.INVITATION_TOKEN_TTL || "7d") as SignOptions["expiresIn"];
const EMAIL_VERIFICATION_TOKEN_TTL = (process.env.EMAIL_VERIFICATION_TOKEN_TTL || "24h") as SignOptions["expiresIn"];
const EMAIL_CHANGE_TOKEN_TTL = (process.env.EMAIL_CHANGE_TOKEN_TTL || "24h") as SignOptions["expiresIn"];

/**
 * A URL that is safe to write to logs: origin and path only. Confirmation and
 * reset links carry their token in the query string, and a logged token is a
 * usable credential (#1450).
 */
export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

/** `someone@example.com` -> `s***@example.com`: enough for the owner to recognise it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export interface EmailProvider {
  sendPasswordResetEmail(input: {
    to: string;
    token: string;
    resetUrl: string;
    locale?: string;
  }): Promise<void>;
  sendInvitationEmail(input: {
    to: string;
    token: string;
    inviteUrl: string;
    inviterWalletAddress?: string;
    locale?: string;
  }): Promise<void>;
  sendVerificationEmail(input: {
    to: string;
    token: string;
    verifyUrl: string;
  }): Promise<void>;
  /** Sent to the NEW address; the change only happens when its link is used (#1448). */
  sendEmailChangeConfirmationEmail(input: {
    to: string;
    token: string;
    confirmUrl: string;
  }): Promise<void>;
  /**
   * Sent to the PRIOR address so its owner can spot an unwanted change (#1448).
   * `requested`: a change was asked for, nothing has changed yet.
   * `completed`: the address on the account is now the new one.
   */
  sendEmailChangeNoticeEmail(input: {
    to: string;
    kind: "requested" | "completed";
    newEmailMasked: string;
  }): Promise<void>;
}

export const LOCALIZED_EMAIL_SUBJECTS: Record<string, { reset: string; invite: string }> = {
  en: { reset: "Reset your SplitNaira password", invite: "You've been invited to collaborate on SplitNaira" },
  fr: { reset: "Réinitialiser votre mot de passe SplitNaira", invite: "Vous avez été invité à collaborer sur SplitNaira" },
  es: { reset: "Restablecer su contraseña de SplitNaira", invite: "Has sido invitado a colaborar en SplitNaira" },
  ha: { reset: "Sake saita kalmar sirri ta SplitNaira", invite: "An gayyace ku don haɗin gwiwa akan SplitNaira" },
  yo: { reset: "Atunse ọrọ igbaniwọle SplitNaira rẹ", invite: "A ti pè ọ lati ṣiṣẹ pọ lori SplitNaira" },
  ig: { reset: "Tọgharia okwu mbanye SplitNaira gị", invite: "A kpọọla gị ka gị na SplitNaira rụkọọ ọrụ" },
};

export function getLocalizedSubjects(locale: string = "en") {
  return LOCALIZED_EMAIL_SUBJECTS[locale] || LOCALIZED_EMAIL_SUBJECTS["en"]!;
}

class ConsoleEmailProvider implements EmailProvider {
  async sendPasswordResetEmail(input: { to: string; token: string; resetUrl: string; locale?: string }): Promise<void> {
    const subjects = getLocalizedSubjects(input.locale);
    logger.info("Password reset email queued", {
      to: input.to,
      resetUrl: input.resetUrl,
      subject: subjects.reset,
      locale: input.locale || "en",
      tokenHash: crypto.createHash("sha256").update(input.token).digest("hex"),
    });
  }

  async sendInvitationEmail(input: {
    to: string;
    token: string;
    inviteUrl: string;
    inviterWalletAddress?: string;
    locale?: string;
  }): Promise<void> {
    const subjects = getLocalizedSubjects(input.locale);
    logger.info("Invitation email queued", {
      to: input.to,
      inviteUrl: input.inviteUrl,
      subject: subjects.invite,
      locale: input.locale || "en",
      inviterWalletAddress: input.inviterWalletAddress,
      tokenHash: crypto.createHash("sha256").update(input.token).digest("hex"),
    });
  }

  async sendVerificationEmail(input: { to: string; token: string; verifyUrl: string }): Promise<void> {
    logger.info("Email verification email queued", {
      to: input.to,
      verifyUrl: redactUrlForLog(input.verifyUrl),
      tokenHash: crypto.createHash("sha256").update(input.token).digest("hex"),
    });
  }

  async sendEmailChangeConfirmationEmail(input: { to: string; token: string; confirmUrl: string }): Promise<void> {
    logger.info("Email change confirmation email queued", {
      to: input.to,
      confirmUrl: redactUrlForLog(input.confirmUrl),
      tokenHash: crypto.createHash("sha256").update(input.token).digest("hex"),
    });
  }

  async sendEmailChangeNoticeEmail(input: {
    to: string;
    kind: "requested" | "completed";
    newEmailMasked: string;
  }): Promise<void> {
    logger.info("Email change notice queued", {
      to: input.to,
      kind: input.kind,
      newEmail: input.newEmailMasked,
    });
  }
}

const provider: EmailProvider = new ConsoleEmailProvider();

type EmailTokenPurpose = "password_reset" | "invitation" | "email_verification" | "email_change";

const TOKEN_TTL_BY_PURPOSE: Record<EmailTokenPurpose, SignOptions["expiresIn"]> = {
  password_reset: PASSWORD_RESET_TOKEN_TTL,
  invitation: INVITATION_TOKEN_TTL,
  email_verification: EMAIL_VERIFICATION_TOKEN_TTL,
  email_change: EMAIL_CHANGE_TOKEN_TTL,
};

export interface EmailFlowTokenClaims {
  /**
   * Session version the token was issued against (#1446). Password reset
   * tokens carry it so a confirm only succeeds once: the confirm bumps the
   * version, which makes the same token stale.
   */
  sv?: number;
  /**
   * Unique token id (#1444). Present on email verification tokens so each
   * issued link is distinguishable even when two links are created in the
   * same second.
   */
  jti?: string;
}

export function signEmailFlowToken(
  email: string,
  purpose: EmailTokenPurpose,
  claims: EmailFlowTokenClaims = {}
): string {
  return jwt.sign({ email, purpose, ...claims }, EMAIL_TOKEN_SECRET, {
    expiresIn: TOKEN_TTL_BY_PURPOSE[purpose],
  });
}

export function verifyEmailFlowToken(
  token: string,
  expectedPurpose: EmailTokenPurpose
): ({ email: string } & EmailFlowTokenClaims) | null {
  try {
    const payload = jwt.verify(token, EMAIL_TOKEN_SECRET) as {
      email?: string;
      purpose?: string;
      sv?: unknown;
      jti?: unknown;
    };
    if (payload.purpose !== expectedPurpose || !payload.email) {
      return null;
    }

    return {
      email: payload.email,
      ...(typeof payload.sv === "number" ? { sv: payload.sv } : {}),
      ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
    };
  } catch {
    return null;
  }
}

export function getEmailProvider(): EmailProvider {
  return provider;
}
