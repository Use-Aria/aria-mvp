// OWNER: 1.4

/**
 * Schools on Canvas LMS with their Canvas hosts (V2-05 §7.1 `universities.ts`). Pure, client-safe.
 *
 * Salvaged from the V1 app's `mobile/lib/universities.ts` and corrected per V2-05 §3.9
 * (live probes 2026-10-10):
 * - Columbia → `courseworks2.columbia.edu` (`canvas.columbia.edu` does not resolve)
 * - Penn State → `psu.instructure.com` (`canvas.psu.edu` redirects to an IT page)
 * - Princeton → `princeton.instructure.com` (`canvas.princeton.edu` is an info site)
 * - UVA → `canvas.its.virginia.edu` (`canvas.virginia.edu` is a Cloudflare front)
 * - Arizona → `arizona.instructure.com` (`canvas.arizona.edu` does not resolve)
 * - Vanderbilt removed (no Canvas account; Vanderbilt is on Brightspace)
 *
 * To add a school: insert an entry keeping the array sorted by name (`localeCompare`), lower-case host.
 */

/** A school and the host its students use for Canvas. */
export interface University {
  name: string;
  /** Host only (no scheme), lower-case, e.g. "yale.instructure.com". */
  canvasDomain: string;
}

/** Picker label for "my school isn't listed" (unlisted hosts must prove they are Canvas at fetch time). */
export const OTHER_UNIVERSITY = "Other" as const;

/** Listed schools, sorted by name. Does not include {@link OTHER_UNIVERSITY}. */
export const UNIVERSITIES: readonly University[] = Object.freeze([
  { name: "Arizona State University", canvasDomain: "canvas.asu.edu" },
  { name: "Boston College", canvasDomain: "bostoncollege.instructure.com" },
  { name: "Brown University", canvasDomain: "canvas.brown.edu" },
  { name: "Carnegie Mellon University", canvasDomain: "canvas.cmu.edu" },
  { name: "Case Western Reserve University", canvasDomain: "canvas.case.edu" },
  { name: "Columbia University", canvasDomain: "courseworks2.columbia.edu" },
  { name: "Cornell University", canvasDomain: "canvas.cornell.edu" },
  { name: "Dartmouth College", canvasDomain: "canvas.dartmouth.edu" },
  { name: "Duke University", canvasDomain: "canvas.duke.edu" },
  { name: "Emory University", canvasDomain: "canvas.emory.edu" },
  { name: "Florida State University", canvasDomain: "canvas.fsu.edu" },
  { name: "Georgetown University", canvasDomain: "georgetown.instructure.com" },
  { name: "Georgia Institute of Technology", canvasDomain: "gatech.instructure.com" },
  { name: "Harvard University", canvasDomain: "canvas.harvard.edu" },
  { name: "Indiana University", canvasDomain: "iu.instructure.com" },
  { name: "Johns Hopkins University", canvasDomain: "jhu.instructure.com" },
  { name: "MIT", canvasDomain: "canvas.mit.edu" },
  { name: "New York University", canvasDomain: "nyu.instructure.com" },
  { name: "Northwestern University", canvasDomain: "canvas.northwestern.edu" },
  { name: "Notre Dame", canvasDomain: "canvas.nd.edu" },
  { name: "Ohio State University", canvasDomain: "osu.instructure.com" },
  { name: "Oregon State University", canvasDomain: "canvas.oregonstate.edu" },
  { name: "Penn State University", canvasDomain: "psu.instructure.com" },
  { name: "Princeton University", canvasDomain: "princeton.instructure.com" },
  { name: "Purdue University", canvasDomain: "purdue.instructure.com" },
  { name: "Rice University", canvasDomain: "rice.instructure.com" },
  { name: "Stanford University", canvasDomain: "canvas.stanford.edu" },
  { name: "Tufts University", canvasDomain: "canvas.tufts.edu" },
  { name: "Tulane University", canvasDomain: "tulane.instructure.com" },
  { name: "UC Berkeley", canvasDomain: "bcourses.berkeley.edu" },
  { name: "UC Davis", canvasDomain: "canvas.ucdavis.edu" },
  { name: "UC San Diego", canvasDomain: "canvas.ucsd.edu" },
  { name: "UC Santa Barbara", canvasDomain: "ucsb.instructure.com" },
  { name: "UCLA", canvasDomain: "bruinlearn.ucla.edu" },
  { name: "University of Arizona", canvasDomain: "arizona.instructure.com" },
  { name: "University of Colorado Boulder", canvasDomain: "canvas.colorado.edu" },
  { name: "University of Florida", canvasDomain: "ufl.instructure.com" },
  { name: "University of Illinois", canvasDomain: "canvas.illinois.edu" },
  { name: "University of Maryland", canvasDomain: "umd.instructure.com" },
  { name: "University of Michigan", canvasDomain: "umich.instructure.com" },
  { name: "University of Minnesota", canvasDomain: "canvas.umn.edu" },
  { name: "University of Oregon", canvasDomain: "canvas.uoregon.edu" },
  { name: "University of Pennsylvania", canvasDomain: "canvas.upenn.edu" },
  { name: "University of Texas at Austin", canvasDomain: "utexas.instructure.com" },
  { name: "University of Utah", canvasDomain: "utah.instructure.com" },
  { name: "University of Virginia", canvasDomain: "canvas.its.virginia.edu" },
  { name: "University of Washington", canvasDomain: "canvas.uw.edu" },
  { name: "University of Wisconsin–Madison", canvasDomain: "canvas.wisc.edu" },
  { name: "USC", canvasDomain: "usc.instructure.com" },
  { name: "Wake Forest University", canvasDomain: "wakeforest.instructure.com" },
  { name: "Yale University", canvasDomain: "yale.instructure.com" },
].map((u) => Object.freeze(u)));

const BY_NAME = new Map<string, University>(UNIVERSITIES.map((u) => [foldName(u.name), u]));
const BY_HOST = new Map<string, University>(UNIVERSITIES.map((u) => [u.canvasDomain, u]));

/** Case/space-insensitive school-name key ("  yale  UNIVERSITY " → "yale university"). */
function foldName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Canvas host for a school name (case- and whitespace-insensitive).
 * @param name school name as shown in the picker, or null
 * @returns host without scheme (e.g. "yale.instructure.com"), or null for unknown names and "Other"
 */
export function canvasHostForSchool(name: string | null): string | null {
  if (typeof name !== "string") return null;
  return BY_NAME.get(foldName(name))?.canvasDomain ?? null;
}

/**
 * Canvas base URL for a school (V1 `canvasDomainForUniversity`, renamed).
 * @param name school name, or null
 * @returns "https://<host>", or null when the school is unknown
 */
export function canvasBaseUrlForUniversity(name: string | null): string | null {
  const host = canvasHostForSchool(name);
  return host ? `https://${host}` : null;
}

/**
 * Canvas Calendar page for the "Open Canvas" button (the Calendar Feed link lives there).
 * @param name school name, or null
 * @returns "https://<host>/calendar", or null when the school is unknown
 */
export function canvasCalendarUrlForUniversity(name: string | null): string | null {
  const base = canvasBaseUrlForUniversity(name);
  return base ? `${base}/calendar` : null;
}

/**
 * Extracts and normalizes a host from a URL or bare host the user typed.
 * @param input e.g. "https://Canvas.Harvard.edu/calendar", "yale.instructure.com.", "x.edu"
 * @returns lower-case host with no trailing dot, or null when it isn't a plausible DNS name
 */
export function normalizeCanvasHost(input: string): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let host: string;
  try {
    const u = new URL(s);
    if (u.username || u.password) return null;
    host = u.hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null; // no IP-v6 brackets, needs a dot
  if (/^[0-9.]+$/.test(host)) return null; // IPv4 literal
  return host;
}

/**
 * Whether `host` is exactly a listed Canvas host.
 * @param host host (no scheme); case and a trailing dot are ignored
 * @returns true for an exact match only (no subdomain or suffix matching)
 */
export function isListedCanvasHost(host: string): boolean {
  return BY_HOST.has(foldHost(host));
}

/**
 * School for a Canvas host.
 * @param host lower-case host (no scheme)
 * @returns the listed school, or null
 */
export function universityForCanvasHost(host: string): University | null {
  return BY_HOST.get(foldHost(host)) ?? null;
}

/** Lower-case, trailing dot removed (exact-match key for {@link BY_HOST}). */
function foldHost(host: string): string {
  return typeof host === "string" ? host.trim().toLowerCase().replace(/\.$/, "") : "";
}
