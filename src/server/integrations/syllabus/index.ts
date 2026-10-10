import "server-only";
// OWNER: 3.5

/**
 * Syllabus integration surface (master plan §1.13; V2-08 §7.2 / §8.2). Barrel over
 * intake / store / signals / dedupe / confirm / client. Consumers:
 * - `@/server/timeline` `listTimeline` → `collapseSyllabusDuplicates` (lazy import)
 * - 4.2 scheduling, V2-06 briefing → `getSyllabusSignals` (third-party text: wrap before a model sees it)
 * - `syllabus_parse` job + `POST /api/syllabus/upload` → `runSyllabusIntake`, `renderSyllabusConfirmation`
 * - `read_syllabus` / `syllabus_info` tools → `findSyllabusByCourse`, `listSyllabi`
 */
export { callParseSyllabus, parseSyllabusCall, ParserError } from "@/server/integrations/syllabus/client";
export type { ParserCallOptions, ParserCallResult } from "@/server/integrations/syllabus/client";
export type * from "@/server/integrations/syllabus/contract";
export type {
  IntakeInput,
  IntakeOutcome,
  NextExam,
  SyllabusRow,
  SyllabusSignals,
  SyllabusSummary,
} from "@/server/integrations/syllabus/types";
export { collapseSyllabusDuplicates, titlesMatch } from "@/server/integrations/syllabus/dedupe";
export { getSyllabusSignals, topicsForExam } from "@/server/integrations/syllabus/signals";
export { runSyllabusIntake } from "@/server/integrations/syllabus/intake";
export { findSyllabusByCourse, listSyllabi } from "@/server/integrations/syllabus/store";
export { displayCourseKey, renderSyllabusConfirmation } from "@/server/integrations/syllabus/confirm";
export { fetchAttachmentPdf, MediaFetchError } from "@/server/integrations/syllabus/media";
