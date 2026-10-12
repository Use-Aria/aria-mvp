/**
 * Draft intent (Wave 5R gate fix H): the deterministic gate for `draft_email` on action-locked
 * runs. Table-driven: requests to write an email match; read / summarize / triage requests don't.
 */
import { hasDraftIntent } from "@/server/agent/draft-intent";

describe("hasDraftIntent", () => {
  it.each([
    "read Prof Kim's email and reply that I'll be there",
    "tell her yes",
    "draft a response",
    "read the latest email from prof kim and draft a reply saying thursday at 4 works for me",
    "can you draft an email to ekim@yale.edu saying i'll miss section on friday because of a doctor's appointment? don't send it yet",
    "can you write an email to ekim@yale.edu? say i can't make section friday bc of a doctor's appointment",
    "draft an email to ekim@yale.edu telling her i'll miss section friday for a doctor's appt",
    "respond to the TA and say thanks",
    "reply yes",
    "answer him, say i can do 3pm",
    "write back that i'm in",
    "write a quick note to my advisor about the form",
    "email prof kim and ask for an extension",
    "email ekim@yale.edu about the makeup quiz",
    "can you email kim asking for an extension",
    "email her back",
    "send him a reply saying sounds good",
    "shoot her an email",
    "let prof kim know i'll be late",
    "let them know i can't come",
    "tell my ta i'm sick",
    "what does it say? also just say i'm in",
    "rsvp yes to the career fair one",
    "rewrite it so it sounds less formal",
    "Read Prof Kim’s email and reply that I’ll be there",
    "what's the dining email about\nreply that i'm coming",
  ])("draft intent: %s", (text) => {
    expect(hasDraftIntent(text)).toBe(true);
  });

  it.each([
    "what's in the yale daily newsletter this week? read it",
    "summarize my inbox",
    "anything important?",
    "anything important in my email?",
    "can you read the latest email from the registrar and tell me what it says?",
    "what did the career center email say? read it",
    "read me the dining email, anything i need to know?",
    "what's the IT help desk email about? read it to me",
    "what does the student life email say? read it",
    "got a weird email from aria support, can you read it?",
    "what does the housing email want? read it",
    "is this security team email legit? read it",
    "did prof kim reply?",
    "has anyone emailed me about the internship",
    "any reply from the registrar yet",
    "email from kim, what's it about",
    "can you say what the newsletter is about",
    "let me know if anything's urgent",
    "check my email",
    "what's due tmr",
    "",
  ])("no draft intent: %s", (text) => {
    expect(hasDraftIntent(text)).toBe(false);
  });
});
