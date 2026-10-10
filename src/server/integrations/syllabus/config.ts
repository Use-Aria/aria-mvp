import "server-only";
// OWNER: 3.5

/**
 * Syllabus env settings (master plan §4; V2-08 §6), read at call time so tests can set them.
 */
import { isProduction, optionalEnv } from "@/server/env";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = optionalEnv(name);
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Resolved syllabus settings. */
export interface SyllabusSettings {
  /** parser base URL, no trailing slash ("" in production when unset → calls fail `not_configured`) */
  parserUrl: string;
  /** client timeout per attempt (must stay < the 300s function cap) */
  parserTimeoutMs: number;
  /** hosts the iMessage media fetch may hit */
  mediaAllowedHosts: string[];
  /** cap for iMessage downloads */
  maxPdfBytes: number;
  /** cap for /setup uploads (Vercel 4.5 MB body) */
  uploadMaxBytes: number;
  /** parses per user per 24 h (shared by chat and upload) */
  dailyLimit: number;
  /** dev only: http + loopback hosts allowed for the dev channel's fixture URLs */
  allowLocalMedia: boolean;
}

/**
 * Current settings. Defaults: parser `http://localhost:8000` (dev), timeout 280s, allowed hosts
 * `localhost,127.0.0.1` outside production, 15 MiB downloads, 4 MB uploads, 5 parses/day.
 * @returns settings
 */
export function syllabusSettings(): SyllabusSettings {
  const hosts = (optionalEnv("SYLLABUS_MEDIA_ALLOWED_HOSTS") ?? (isProduction ? "" : "localhost,127.0.0.1"))
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  return {
    parserUrl: (optionalEnv("PARSER_SERVICE_URL") ?? (isProduction ? "" : "http://localhost:8000")).replace(/\/+$/, ""),
    parserTimeoutMs: intEnv("PARSER_TIMEOUT_MS", 280_000, 5_000, 295_000),
    mediaAllowedHosts: hosts,
    maxPdfBytes: intEnv("SYLLABUS_MAX_PDF_BYTES", 15_728_640, 1024, 50 * 1024 * 1024),
    uploadMaxBytes: intEnv("SYLLABUS_UPLOAD_MAX_BYTES", 4_000_000, 1024, 4_400_000),
    dailyLimit: intEnv("SYLLABUS_DAILY_LIMIT", 5, 0, 1000),
    allowLocalMedia: !isProduction,
  };
}
