"use client";
// OWNER: 4.5

/**
 * Canvas section of /setup (web plan §7.4, copy deck §9.2): school picker ("My school isn't
 * listed" → Canvas address input), Calendar Feed guide with the resolved
 * `https://<host>/calendar` link and "Copy Canvas address", paste field with a client pre-check
 * on blur and submit, `connectCanvasAction` via `useActionState`, connected status, "Use a
 * different link", and Disconnect behind a confirm dialog.
 *
 * Connecting needs a fresh setup session (`canChange`); without one the guide still shows (the
 * link can also be pasted into the chat) along with the fresh-link notice: the server-rendered
 * `FreshLinkNotice` passed in as `freshNotice` (a client component can't render it), else a
 * text-only fallback. The pasted URL is a
 * bearer secret: it stays in this component's state (kept on failure, cleared on success) and
 * the server never echoes it back.
 *
 * Also exports `StripSearchParam`, a tiny client helper the server-rendered Google section uses
 * to drop `?google=` from the address bar after showing its banner (one client file per section).
 */
import { useActionState, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Banner } from "@/app/_components/ui/Banner";
import { Button, buttonClass } from "@/app/_components/ui/Button";
import { ConfirmDialog } from "@/app/_components/ui/ConfirmDialog";
import { FIELD_CONTROL_CLASS, Field } from "@/app/_components/ui/Field";
import { Section } from "@/app/_components/ui/Section";
import { SubmitButton } from "@/app/_components/ui/SubmitButton";
import type { CanvasStatusView } from "@/server/integrations/canvas";
import { CANVAS_CONNECT_ERROR_CODES, type ActionErrorCode, type ActionResult, type CanvasConnectErrorCode } from "@/shared/action-result";
import { precheckIcalUrl } from "@/shared/canvas-url";
import { ACTION_ERROR_COPY, CANVAS_ERROR_COPY, SETUP_COPY, SHARED_COPY, type BannerTone } from "@/shared/copy";
import {
  OTHER_UNIVERSITY,
  UNIVERSITIES,
  canvasHostForSchool,
  normalizeCanvasHost,
  universityForCanvasHost,
} from "@/shared/universities";
import { connectCanvasAction, disconnectCanvasAction, type CanvasConnected } from "./integration-actions";

type FieldErrorCode = CanvasConnectErrorCode | "empty";
type Notice = { tone: BannerTone; text: string; seeWeek?: boolean };

const DISCONNECTED_TEXT = "Canvas disconnected. Aria stopped checking it and removed your Canvas deadlines.";

/**
 * School the picker starts on: the profile school when it is listed, else the school of the
 * connected Canvas host, else "Other" for a connected unlisted host, else nothing picked.
 * @param school profile school (free text), or null
 * @param status Canvas status
 * @returns a listed school name, `OTHER_UNIVERSITY`, or ""
 */
export function initialSchool(school: string | null, status: CanvasStatusView): string {
  const listedHost = canvasHostForSchool(school);
  if (listedHost) return universityForCanvasHost(listedHost)?.name ?? "";
  if (status.connected) return universityForCanvasHost(status.host)?.name ?? OTHER_UNIVERSITY;
  return "";
}

/**
 * Canvas host the guide links to.
 * @param selected picker value
 * @param customHost what the user typed for an unlisted school
 * @returns a lower-case host, or null when unknown / not a plausible DNS name
 */
export function guideHost(selected: string, customHost: string): string | null {
  if (selected === OTHER_UNIVERSITY) return normalizeCanvasHost(customHost);
  return canvasHostForSchool(selected);
}

/**
 * Whether a connect failure belongs on the URL field (vs. a banner: session, origin, server).
 * @param code action error code
 * @returns true for Canvas URL/feed problems
 */
export function isFieldError(code: ActionErrorCode): boolean {
  return (CANVAS_CONNECT_ERROR_CODES as readonly string[]).includes(code) && code !== "internal" && code !== "rate_limited";
}

/**
 * Banner copy for a successful connect.
 * @param r connect result
 * @returns success notice (with "See your week" when something is due)
 */
export function connectedNotice(r: CanvasConnected): Notice {
  return r.upcomingCount > 0
    ? { tone: "ok", text: SETUP_COPY.canvas.successSome(r.upcomingCount), seeWeek: true }
    : { tone: "ok", text: SETUP_COPY.canvas.successNone };
}

function clock(d: Date | string | null): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
}

/**
 * Removes one query parameter from the address bar after mount (keeps Next's history state),
 * so a reload doesn't repeat a one-time banner.
 * @param props the parameter name, e.g. "google"
 * @returns nothing visible
 */
export function StripSearchParam({ name }: { name: string }) {
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(name)) return;
      url.searchParams.delete(name);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Older browsers: leaving the param is harmless (the banner just shows again on reload).
    }
  }, [name]);
  return null;
}

function Guide({ host }: { host: string | null }) {
  const copy = SETUP_COPY.canvas;
  const [copied, setCopied] = useState(false);
  const calendarUrl = host ? `https://${host}/calendar` : null;

  async function copyAddress() {
    if (!calendarUrl) return;
    try {
      await navigator.clipboard.writeText(calendarUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-3xl bg-bubble p-5">
      <h3 className="text-lg font-semibold">{copy.guideTitle}</h3>
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-base leading-relaxed">
        <li>
          {copy.step1}
          {calendarUrl && host && (
            <span className="mt-2 flex flex-wrap gap-2">
              <a href={calendarUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary")}>
                {copy.step1Link(host)}
              </a>
            </span>
          )}
        </li>
        <li>{copy.step2}</li>
        <li>{copy.step3}</li>
      </ol>
      <p className="text-sm leading-relaxed text-ink-soft">{copy.guideTip}</p>
      {calendarUrl && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" onClick={copyAddress}>
            {copy.copyAddress}
          </Button>
          <span role="status" className="text-sm text-ink-soft">
            {copied ? copy.copied : ""}
          </span>
        </div>
      )}
      <p className="text-sm text-ink-soft">{copy.guideAlt}</p>
    </div>
  );
}

/**
 * @param props the user's school (picker default), Canvas status, whether this session may connect,
 *   and an optional server-rendered fresh-link notice shown (instead of the text-only one) when it can't
 * @returns the Canvas section (`#canvas`)
 */
export function CanvasConnect({
  school,
  status,
  canChange,
  freshNotice,
}: {
  school: string | null;
  status: CanvasStatusView;
  canChange: boolean;
  freshNotice?: ReactNode;
}) {
  const copy = SETUP_COPY.canvas;
  const ids = useId();
  const urlRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(() => initialSchool(school, status));
  const [customHost, setCustomHost] = useState(() =>
    status.connected && !universityForCanvasHost(status.host) ? status.host : "",
  );
  const [url, setUrl] = useState("");
  const [fieldError, setFieldError] = useState<FieldErrorCode | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [replacing, setReplacing] = useState(false);

  const [, connectAction] = useActionState(
    async (prev: ActionResult<CanvasConnected> | null, form: FormData) => {
      const r = await connectCanvasAction(prev, form);
      if (r.ok) {
        setUrl("");
        setFieldError(null);
        setReplacing(false);
        setNotice(connectedNotice(r.data));
      } else if (isFieldError(r.code)) {
        setFieldError(r.code as CanvasConnectErrorCode);
        setNotice(null);
        urlRef.current?.focus();
      } else {
        setNotice({ tone: r.code === "rate_limited" ? "warn" : "error", text: ACTION_ERROR_COPY[r.code] });
      }
      return r;
    },
    null,
  );

  const [, disconnectAction] = useActionState(async (prev: ActionResult | null) => {
    void prev;
    const r = await disconnectCanvasAction();
    setNotice(r.ok ? { tone: "ok", text: DISCONNECTED_TEXT } : { tone: "error", text: ACTION_ERROR_COPY[r.code] });
    if (r.ok) setReplacing(false);
    return r;
  }, null);

  function precheck(value: string, onSubmit: boolean): boolean {
    const r = precheckIcalUrl(value);
    if (r.ok) {
      setFieldError(null);
      return true;
    }
    if (r.code === "empty" && !onSubmit) {
      setFieldError(null);
      return false;
    }
    setFieldError(r.code);
    return false;
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    if (!precheck(url, true)) {
      e.preventDefault();
      urlRef.current?.focus();
    }
  }

  const host = guideHost(selected, customHost);
  const connected = status.connected;
  const healthy = connected && status.health === "ok";
  const showForm = canChange && (!connected || !healthy || replacing);
  const showGuide = !connected || !healthy || showForm;
  const lastChecked = connected ? clock(status.syncedAt) : null;

  return (
    <Section
      id="canvas"
      title={copy.title}
      status={connected ? copy.connected : copy.notConnected}
      statusTone={connected ? (healthy ? "ok" : "warn") : "neutral"}
    >
      <p className="text-base leading-relaxed text-ink-soft">{copy.intro}</p>

      {notice && (
        <Banner tone={notice.tone} focusOnMount>
          <p>{notice.text}</p>
          {notice.seeWeek && (
            <p className="mt-2">
              <a href="/week" className="font-semibold text-aria underline underline-offset-4">
                {copy.seeWeek}
              </a>
            </p>
          )}
        </Banner>
      )}

      {connected && (
        <div className="flex flex-col gap-3">
          {healthy ? (
            <p className="text-base" suppressHydrationWarning>
              {lastChecked ? copy.connectedStatus(status.host, lastChecked) : `Connected to ${status.host}.`}
            </p>
          ) : (
            <div className="flex flex-col gap-1 rounded-2xl bg-warn-bg px-4 py-3 text-base leading-relaxed">
              <p suppressHydrationWarning>
                {lastChecked
                  ? copy.failing(lastChecked)
                  : "Aria couldn't read your Canvas feed. Paste a fresh Calendar Feed link to fix it."}
              </p>
              {status.lastError && status.lastError !== "internal" && (
                <p className="text-ink-soft">{CANVAS_ERROR_COPY[status.lastError]}</p>
              )}
            </div>
          )}
          <p className="text-sm text-ink-soft">{status.urlHint}</p>
          {canChange && (
            <div className="flex flex-wrap gap-3">
              {healthy && !replacing && (
                <Button variant="secondary" onClick={() => setReplacing(true)}>
                  {copy.useDifferent}
                </Button>
              )}
              <ConfirmDialog
                trigger={copy.disconnect}
                title={copy.disconnectConfirm.title}
                confirmLabel={copy.disconnectConfirm.confirm}
                cancelLabel={copy.disconnectConfirm.cancel}
                pendingLabel="Disconnecting…"
                formAction={disconnectAction}
              >
                {copy.disconnectConfirm.body}
              </ConfirmDialog>
            </div>
          )}
        </div>
      )}

      {showGuide && (
        <div className="flex flex-col gap-4">
          <Field id={`${ids}-school`} label={copy.schoolLabel}>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className={FIELD_CONTROL_CLASS}
            >
              <option value="">Pick your school</option>
              {UNIVERSITIES.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name}
                </option>
              ))}
              <option value={OTHER_UNIVERSITY}>{copy.schoolUnlisted}</option>
            </select>
          </Field>
          {selected === OTHER_UNIVERSITY && (
            <Field id={`${ids}-host`} label={copy.customHostLabel} hint={copy.customHostHint}>
              <input
                type="text"
                value={customHost}
                onChange={(e) => setCustomHost(e.target.value)}
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={253}
                placeholder="canvas.myschool.edu"
                className={FIELD_CONTROL_CLASS}
              />
            </Field>
          )}
          <Guide host={host} />
        </div>
      )}

      {showForm ? (
        <form action={connectAction} onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          {selected && <input type="hidden" name="school" value={selected} />}
          {selected === OTHER_UNIVERSITY && host && <input type="hidden" name="customHost" value={host} />}
          <Field
            id={`${ids}-url`}
            label={copy.pasteLabel}
            error={fieldError ? CANVAS_ERROR_COPY[fieldError] : undefined}
          >
            <input
              ref={urlRef}
              name="url"
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (fieldError) setFieldError(null);
              }}
              onBlur={(e) => {
                if (e.target.value.trim()) precheck(e.target.value, false);
              }}
              placeholder={copy.pastePlaceholder}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={2048}
              className={FIELD_CONTROL_CLASS}
            />
          </Field>
          <div className="flex flex-wrap gap-3">
            <SubmitButton pendingLabel={copy.connectPending}>{copy.connect}</SubmitButton>
            {replacing && (
              <Button variant="ghost" onClick={() => setReplacing(false)}>
                Keep the current link
              </Button>
            )}
          </div>
        </form>
      ) : (
        !canChange &&
        (freshNotice ?? (
          <p role="status" className="rounded-2xl bg-warn-bg px-4 py-4 text-base leading-relaxed">
            {SHARED_COPY.freshLinkNeeded}
          </p>
        ))
      )}
    </Section>
  );
}
