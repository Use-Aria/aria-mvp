/**
 * Unit tests for src/server/integrations/google/gmail/prefilter.ts (V2-07 §10 `prefilter.test.ts`,
 * §2.10 rule table). Table-driven fixtures; pure. Run: npm test -- tests/unit/google/prefilter.test.ts
 */
import { courseCodePatterns, prefilterEmail, type PrefilterContext } from "@/server/integrations/google/gmail/prefilter";
import type { EmailMeta } from "@/server/integrations/google/gmail/types";

const ctx: PrefilterContext = {
  selfEmail: "Me@Gmail.com",
  courses: ["CPSC 323: Systems Programming", "ECON 115", "Art"],
  schoolDomains: ["uni.ac.uk"],
};

function meta(p: Partial<EmailMeta> & { fromEmail?: string; fromName?: string }): EmailMeta {
  const { fromEmail, fromName, ...rest } = p;
  return {
    id: "18c1f2a3b4c5d6e7",
    threadId: "18c1f2a3b4c5d6e7",
    labels: ["INBOX", "UNREAD"],
    snippet: "",
    internalDate: new Date("2026-10-10T12:00:00Z"),
    from: fromEmail ? { name: fromName ?? null, email: fromEmail } : null,
    replyTo: [],
    to: [{ name: null, email: "me@gmail.com" }],
    cc: [],
    subject: "",
    messageId: "<x@y>",
    references: null,
    listUnsubscribe: false,
    autoSubmitted: null,
    precedence: null,
    ...rest,
  };
}

const newsletter = { listUnsubscribe: true, labels: ["INBOX", "CATEGORY_UPDATES"] };

const cases: [string, EmailMeta, string][] = [
  // rule 1 — junk / self
  ["spam label", meta({ fromEmail: "prof@yale.edu", labels: ["SPAM"] }), "skip:self_or_junk"],
  ["trash label", meta({ fromEmail: "prof@yale.edu", labels: ["TRASH", "INBOX"] }), "skip:self_or_junk"],
  ["sent by me", meta({ fromEmail: "me@gmail.com", labels: ["INBOX", "SENT"], subject: "exam" }), "skip:self_or_junk"],
  ["self-sent (case-insensitive)", meta({ fromEmail: "me@gmail.com", subject: "interview notes" }), "skip:self_or_junk"],
  ["draft", meta({ fromEmail: "x@y.com", labels: ["DRAFT"] }), "skip:self_or_junk"],
  // rule 2 — categories
  ["promotions newsletter", meta({ fromEmail: "deals@shop.com", labels: ["INBOX", "CATEGORY_PROMOTIONS"], subject: "Offer ends today!" }), "skip:category"],
  ["social notification", meta({ fromEmail: "notify@social.com", labels: ["INBOX", "CATEGORY_SOCIAL"], subject: "You have an interview?" }), "skip:category"],
  ["promotions beats .edu", meta({ fromEmail: "events@yale.edu", labels: ["CATEGORY_PROMOTIONS"] }), "skip:category"],
  // rule 3 — Canvas
  [
    "Canvas due-date change notification",
    meta({ fromEmail: "notifications@instructure.com", ...newsletter, subject: "Assignment Due Date Changed: PS3, CPSC 323" }),
    "classify:canvas",
  ],
  ["Canvas school subdomain", meta({ fromEmail: "notifications@yale.instructure.com", ...newsletter }), "classify:canvas"],
  // rule 4 — Gradescope
  ["Gradescope receipt", meta({ fromEmail: "no-reply@gradescope.com", ...newsletter, subject: "Successfully submitted to PS3" }), "classify:gradescope"],
  // rule 5 — recruiters
  ["Greenhouse interview invite", meta({ fromEmail: "no-reply@us.greenhouse-mail.io", ...newsletter, subject: "Interview invitation" }), "classify:recruiter"],
  ["Lever", meta({ fromEmail: "jobs@hire.lever.co", ...newsletter }), "classify:recruiter"],
  ["Workday subdomain", meta({ fromEmail: "acme@myworkday.com", ...newsletter }), "classify:recruiter"],
  ["Handshake", meta({ fromEmail: "messages@joinhandshake.com", ...newsletter }), "classify:recruiter"],
  // rule 6 — school
  ["professor .edu email", meta({ fromEmail: "smith@cs.yale.edu", subject: "lecture notes" }), "classify:school"],
  ["bulk .edu still school", meta({ fromEmail: "digest@yale.edu", ...newsletter, subject: "weekly digest" }), "classify:school"],
  ["extra school domain", meta({ fromEmail: "tutor@cs.uni.ac.uk", ...newsletter }), "classify:school"],
  ["course-code subject from a gmail.com TA", meta({ fromEmail: "ta.jane@gmail.com", ...newsletter, subject: "cpsc323 section moved" }), "classify:school"],
  ["course code with hyphen", meta({ fromEmail: "x@gmail.com", ...newsletter, subject: "[ECON-115] slides" }), "classify:school"],
  // rule 7 — keywords
  ["bulk with 'interview' keyword", meta({ fromEmail: "news@company.com", ...newsletter, subject: "Your interview is confirmed" }), "classify:keyword"],
  ["keyword in snippet", meta({ fromEmail: "bot@service.com", ...newsletter, subject: "Update", snippet: "your deadline was extended" }), "classify:keyword"],
  ["'by friday'", meta({ fromEmail: "bot@service.com", ...newsletter, subject: "Please submit by Friday" }), "classify:keyword"],
  ["rescheduled", meta({ fromEmail: "bot@service.com", ...newsletter, subject: "Meeting rescheduled" }), "classify:keyword"],
  // rule 8 — human-looking
  ["personal human email", meta({ fromEmail: "mom@gmail.com", fromName: "Mom", subject: "dinner sunday?" }), "classify:personal"],
  ["CATEGORY_PERSONAL human", meta({ fromEmail: "friend@outlook.com", labels: ["INBOX", "CATEGORY_PERSONAL"], subject: "hey" }), "classify:personal"],
  // rule 9 — bulk
  ["bulk with List-Unsubscribe and no keyword", meta({ fromEmail: "news@company.com", ...newsletter, subject: "Our October newsletter" }), "skip:bulk"],
  ["Auto-Submitted: auto-replied", meta({ fromEmail: "someone@company.com", autoSubmitted: "auto-replied", subject: "Out of office" }), "skip:bulk"],
  ["Precedence: bulk", meta({ fromEmail: "list@company.com", precedence: "bulk", subject: "hello all" }), "skip:bulk"],
  ["updates tab, no unsubscribe", meta({ fromEmail: "receipts@store.com", labels: ["INBOX", "CATEGORY_UPDATES"], subject: "Your receipt" }), "skip:bulk"],
  ["bare 'Art' course name never matches", meta({ fromEmail: "x@shop.com", ...newsletter, subject: "Art supplies sale" }), "skip:bulk"],
];

describe("prefilterEmail", () => {
  it.each(cases)("%s → %s", (_name, m, want) => {
    const r = prefilterEmail(m, ctx);
    expect(r.reason).toBe(want);
    if (want.startsWith("classify:")) {
      expect(r).toEqual({ decision: "classify", hint: want.slice("classify:".length), reason: want });
    } else {
      expect(r.decision).toBe("skip");
    }
  });

  it("covers at least 25 fixtures", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  it("treats Auto-Submitted: no as human", () => {
    expect(prefilterEmail(meta({ fromEmail: "a@b.com", autoSubmitted: "no" }), ctx).reason).toBe("classify:personal");
  });

  it("handles a missing From header", () => {
    expect(prefilterEmail(meta({ subject: "hello" }), ctx).reason).toBe("classify:personal");
    expect(prefilterEmail(meta({ ...newsletter, subject: "hello" }), ctx).reason).toBe("skip:bulk");
  });

  it("does not treat lookalike domains as Canvas / recruiters", () => {
    expect(prefilterEmail(meta({ fromEmail: "x@notinstructure.com", ...newsletter }), ctx).reason).toBe("skip:bulk");
    expect(prefilterEmail(meta({ fromEmail: "x@evil-lever.co", ...newsletter }), ctx).reason).toBe("skip:bulk");
  });
});

describe("courseCodePatterns", () => {
  it("extracts dept+number codes and ignores bare words", () => {
    const res = courseCodePatterns(["CPSC 323: Systems", "cpsc 323", "Art", "MATH 120a"]);
    expect(res).toHaveLength(2);
    expect(res[0].test("CPSC-323 pset")).toBe(true);
    expect(res[1].test("math120A quiz")).toBe(true);
    expect(res[0].test("CPSC 3230")).toBe(false);
  });
});
