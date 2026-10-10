import "server-only";
// OWNER: 2.4

/**
 * Google error classes (master plan §1.12; V2-07 §7.1 `errors.ts`). Real in Wave 0 (no I/O).
 */
import type { GoogleFeature } from "@/server/integrations/google";

/** A Google API call failed. */
export class GoogleApiError extends Error {
  status: number;
  reason?: string;
  retryable: boolean;

  constructor(message: string, o: { status: number; reason?: string; retryable: boolean }) {
    super(message);
    this.name = "GoogleApiError";
    this.status = o.status;
    this.reason = o.reason;
    this.retryable = o.retryable;
  }
}

/** The refresh token is no longer usable (user revoked access, or a Workspace admin blocked the app). */
export class GoogleAuthRevokedError extends Error {
  kind: "invalid_grant" | "admin_policy_enforced";

  constructor(kind: "invalid_grant" | "admin_policy_enforced", message = `google auth revoked: ${kind}`) {
    super(message);
    this.name = "GoogleAuthRevokedError";
    this.kind = kind;
  }
}

/** The user has no active Google integration (or lacks the feature's scope). */
export class GoogleNotConnectedError extends Error {
  feature?: GoogleFeature;

  constructor(feature?: GoogleFeature, message = feature ? `google not connected for ${feature}` : "google not connected") {
    super(message);
    this.name = "GoogleNotConnectedError";
    this.feature = feature;
  }
}
