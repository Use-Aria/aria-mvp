"use client";
// OWNER: 3.5 (placeholder by 1.6 with final props; 3.5 replaced the body per V2-08 §7.2)

/**
 * Syllabus section of /setup: PDF file input + optional course hint, POSTed (multipart) to
 * `/api/syllabus/upload`. The parse runs while the request is open (up to a couple of minutes),
 * so the form shows a progress line, then Aria's confirmation as a banner. When the hinted course
 * already has a saved syllabus, a "Replace it" button re-sends the same file with `replace=1`.
 * Client-only: no server imports (the response type is mirrored here).
 */
import { useRef, useState, type FormEvent } from "react";
import { Banner } from "@/app/_components/ui/Banner";
import { Button } from "@/app/_components/ui/Button";
import { FIELD_CONTROL_CLASS, Field } from "@/app/_components/ui/Field";
import { Section } from "@/app/_components/ui/Section";
import { ACTION_ERROR_COPY, SETUP_COPY, type BannerTone } from "@/shared/copy";

/** Mirrors the route's default `SYLLABUS_UPLOAD_MAX_BYTES` (the server check is authoritative). */
const MAX_BYTES = 4_000_000;

type Status = "ok" | "needs_review" | "exists" | "not_syllabus" | "unreadable" | "rate_limited" | "failed";
type UploadResponse =
  | { ok: true; status: Status; bubbles: string[]; canReplace?: boolean }
  | { ok: false; code: string; status?: Status; bubbles?: string[] };

type Result = { tone: BannerTone; lines: string[]; canReplace: boolean };

const ERROR_TEXT: Record<string, string> = {
  too_large: "That file is over 4 MB. Upload just the syllabus pages, or send the PDF to Aria in Messages.",
  not_pdf: "That isn't a PDF. Export the syllabus as a PDF and try again.",
  invalid: "Pick a PDF file first.",
  signed_out: ACTION_ERROR_COPY.signed_out,
  bad_origin: ACTION_ERROR_COPY.bad_origin,
  needs_recent_link: ACTION_ERROR_COPY.needs_recent_link,
  needs_fresh_link: ACTION_ERROR_COPY.needs_fresh_link,
  server: ACTION_ERROR_COPY.server,
};

function toneFor(status: Status | undefined): BannerTone {
  if (status === "ok") return "ok";
  if (status === "failed" || status === undefined) return "error";
  return "warn";
}

function resultFrom(body: UploadResponse): Result {
  const bubbles = body.bubbles ?? [];
  if (bubbles.length > 0) {
    return { tone: toneFor(body.status), lines: bubbles, canReplace: body.ok && body.canReplace === true };
  }
  const code = body.ok ? "server" : body.code;
  return { tone: "error", lines: [ERROR_TEXT[code] ?? ERROR_TEXT.server], canReplace: false };
}

/** @returns the syllabus section (`#syllabus`) */
export function SyllabusUpload() {
  const formRef = useRef<HTMLFormElement>(null);
  const lastForm = useRef<FormData | null>(null);
  const [pending, setPending] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function send(data: FormData) {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch("/api/syllabus/upload", { method: "POST", body: data, credentials: "same-origin" });
      const body = (await res.json().catch(() => ({ ok: false, code: "server" }))) as UploadResponse;
      setResult(resultFrom(body));
      if (body.ok && (body.status === "ok" || body.status === "needs_review")) formRef.current?.reset();
    } catch {
      setResult({ tone: "error", lines: ["You look offline. Check your connection and try again."], canReplace: false });
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFileError(null);
    const data = new FormData(e.currentTarget);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setFileError(ERROR_TEXT.invalid);
      return;
    }
    if (file.size > MAX_BYTES) {
      setFileError(ERROR_TEXT.too_large);
      return;
    }
    lastForm.current = data;
    await send(data);
  }

  async function onReplace() {
    const prev = lastForm.current;
    if (!prev) return;
    const data = new FormData();
    for (const [k, v] of prev.entries()) data.append(k, v);
    data.set("replace", "1");
    await send(data);
  }

  return (
    <Section id="syllabus" title={SETUP_COPY.syllabus.title}>
      <p className="text-base leading-relaxed text-ink-soft">{SETUP_COPY.syllabus.intro}</p>
      <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4" noValidate aria-busy={pending}>
        <Field id="syllabus-file" label="Syllabus PDF" hint="Up to 4 MB." error={fileError ?? undefined}>
          <input
            name="file"
            type="file"
            accept="application/pdf,.pdf"
            required
            disabled={pending}
            className={`${FIELD_CONTROL_CLASS} py-3 file:mr-3 file:rounded-full file:border-0 file:bg-bubble file:px-3 file:py-1 file:text-sm file:font-medium file:text-ink`}
          />
        </Field>
        <Field id="syllabus-course" label="Which class? (optional)" hint="Like “CPSC 223” or “orgo”.">
          <input
            name="courseHint"
            type="text"
            maxLength={80}
            autoComplete="off"
            disabled={pending}
            className={FIELD_CONTROL_CLASS}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending} aria-disabled={pending}>
            {pending ? "Reading it…" : "Upload syllabus"}
          </Button>
        </div>
        {pending && (
          <p role="status" className="text-base text-ink-soft">
            Aria is reading your syllabus. This can take a minute or two, so keep this page open.
          </p>
        )}
      </form>
      {result && (
        <Banner tone={result.tone} focusOnMount>
          <div className="flex flex-col gap-2">
            {result.lines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            {result.canReplace && (
              <div>
                <Button variant="secondary" onClick={onReplace} disabled={pending}>
                  Replace it
                </Button>
              </div>
            )}
          </div>
        </Banner>
      )}
    </Section>
  );
}
