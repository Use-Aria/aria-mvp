/**
 * Copy deck coverage (web plan §10 copy.test): every action error, Canvas error, and Google
 * callback code has non-empty, specific copy. Compile-time checks keep the shared code lists
 * in sync with the server contracts they mirror.
 */
import type { CanvasConnectError } from "@/server/integrations/canvas";
import type { GoogleConnectStatus } from "@/server/integrations/google";
import {
  ACTION_ERROR_CODES,
  CANVAS_CONNECT_ERROR_CODES,
  isSkewError,
  type CanvasConnectErrorCode,
} from "@/shared/action-result";
import {
  ACTION_ERROR_COPY,
  CANVAS_ERROR_COPY,
  EMAIL_COPY,
  GOOGLE_CONNECT_CODES,
  GOOGLE_STATUS_COPY,
  SETTINGS_COPY,
  SETUP_COPY,
  SHARED_COPY,
  WEEK_COPY,
  actionErrorCopy,
  parseGoogleConnectCode,
  type GoogleConnectCode,
} from "@/shared/copy";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const canvasInSync: Equals<CanvasConnectError, CanvasConnectErrorCode> = true;
const googleInSync: Equals<GoogleConnectStatus, GoogleConnectCode> = true;

const VAGUE = /error occurred|invalid input|something went wrong|unknown error/i;

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("copy coverage", () => {
  it("server and shared code lists match", () => {
    expect(canvasInSync && googleInSync).toBe(true);
  });

  it("every ActionErrorCode has specific copy", () => {
    for (const code of ACTION_ERROR_CODES) {
      expect(ACTION_ERROR_COPY[code].length).toBeGreaterThan(15);
      expect(actionErrorCopy(code)).toBe(ACTION_ERROR_COPY[code]);
    }
  });

  it("every Canvas error (plus 'empty') has copy", () => {
    for (const code of [...CANVAS_CONNECT_ERROR_CODES, "empty" as const]) {
      expect(CANVAS_ERROR_COPY[code].length).toBeGreaterThan(15);
    }
    expect(ACTION_ERROR_COPY.feed_not_found).toBe(CANVAS_ERROR_COPY.feed_not_found);
  });

  it("every Google callback code has a banner", () => {
    for (const code of GOOGLE_CONNECT_CODES) {
      expect(GOOGLE_STATUS_COPY[code].text.length).toBeGreaterThan(15);
      expect(["ok", "warn", "error"]).toContain(GOOGLE_STATUS_COPY[code].tone);
    }
  });

  it("no vague strings anywhere in the deck", () => {
    const all = [
      ...strings(SHARED_COPY),
      ...strings(ACTION_ERROR_COPY),
      ...strings(CANVAS_ERROR_COPY),
      ...strings(GOOGLE_STATUS_COPY),
      ...strings(SETUP_COPY),
      ...strings(WEEK_COPY),
      ...strings(SETTINGS_COPY),
      ...strings(EMAIL_COPY),
    ];
    expect(all.length).toBeGreaterThan(100);
    for (const s of all) expect(s).not.toMatch(VAGUE);
  });

  it("template helpers interpolate", () => {
    expect(SHARED_COPY.freshUntil("3:42 PM")).toBe("You can connect accounts until 3:42 PM.");
    expect(WEEK_COPY.dayLoadLabel("busy", 2)).toBe("Busy day: 2 things due");
    expect(WEEK_COPY.dayLoadLabel("light", 1)).toBe("Light day");
    expect(SETUP_COPY.canvas.successSome(1)).toContain("1 thing due");
  });
});

describe("parseGoogleConnectCode", () => {
  it("allow-lists query values", () => {
    expect(parseGoogleConnectCode("missing_scopes")).toBe("missing_scopes");
    expect(parseGoogleConnectCode("<script>")).toBeNull();
    expect(parseGoogleConnectCode("toString")).toBeNull();
    expect(parseGoogleConnectCode(undefined)).toBeNull();
    expect(parseGoogleConnectCode(["connected"])).toBeNull();
  });
});

describe("isSkewError", () => {
  it("detects Next's missing-action error", () => {
    expect(
      isSkewError(
        'Server Action "7f3a" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
      ),
    ).toBe(true);
    expect(isSkewError("Failed to find Server Action")).toBe(true);
    expect(isSkewError("An error occurred in the Server Components render.")).toBe(false);
    expect(isSkewError(undefined)).toBe(false);
  });
});
