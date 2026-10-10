import type { Metadata } from "next";
import { LegalSection } from "@/app/_components/LegalSection";
import { PlainPage } from "@/app/_components/PlainPage";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Aria collects, why, who processes it, and how to delete it.",
};

/** Minimal plain-language privacy policy for the private test (master plan §6 D5). */
export default function PrivacyPage() {
  return (
    <PlainPage center={false}>
      <div className="flex flex-col gap-3">
        <h1 className="text-4xl font-bold leading-tight tracking-[-0.02em]">Privacy</h1>
        <p className="text-lg leading-relaxed text-ink-soft">
          Aria is a small private test run by Daniel Lee for a handful of friends. This page says what
          Aria keeps, why, and how to get rid of it. Last updated October 10, 2026.
        </p>
      </div>

      <LegalSection title="What Aria collects">
        <ul>
          <li>
            <strong>Your phone number or iMessage address</strong> and the name you give, so Aria knows
            who&apos;s texting.
          </li>
          <li>
            <strong>Your messages with Aria</strong>, so it can answer in context. Messages are deleted
            after 180 days.
          </li>
          <li>
            <strong>Things you tell Aria to remember</strong>, like your school, courses, and
            preferences. You can see, edit, and delete these in Settings.
          </li>
          <li>
            <strong>Your Canvas calendar feed</strong>, if you connect it: assignment and exam titles
            and due dates. Aria can&apos;t see grades or submissions.
          </li>
          <li>
            <strong>Gmail and Google Calendar</strong>, if you connect them: Aria reads your inbox to
            flag emails that matter and to give drafts context, reads your calendar to plan around it,
            and writes only to its own &ldquo;Aria&rdquo; calendar. It stores short summaries of
            important emails, not full message bodies.
          </li>
          <li>
            <strong>Syllabi you send</strong>: the exams, weights, and topics Aria pulls out of them.
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="How Aria uses it">
        <p>
          Only to be your assistant: reminders, your morning briefing, deadline alerts, scheduling, and
          email drafts. Aria sends an email only after you confirm it. It never sells your data, never
          uses it for ads, and never uses it to train AI models.
        </p>
        <p>
          Aria&apos;s use and transfer of information received from Google APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="text-aria underline underline-offset-4"
            rel="noopener noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </LegalSection>

      <LegalSection title="Who else handles it">
        <p>Aria uses a few services to run. Each one only gets what it needs:</p>
        <ul>
          <li>Anthropic (Claude), with OpenAI as a backup, to understand and write messages. They don&apos;t train on it.</li>
          <li>Sendblue, to send and receive iMessages.</li>
          <li>Supabase, to store data. Google tokens and your Canvas link are encrypted.</li>
          <li>Vercel and Google Cloud, to run the app and read syllabus PDFs.</li>
          <li>Upstash, to rate-limit requests.</li>
        </ul>
      </LegalSection>

      <LegalSection title="Deleting your data">
        <p>
          Text Aria &ldquo;delete my account&rdquo;, or use Delete my account in Settings. Aria deletes
          your messages, deadlines, memories, and settings, and disconnects Google and Canvas. You can
          also remove Aria&apos;s Google access anytime at myaccount.google.com/permissions, and text
          STOP to stop all messages.
        </p>
      </LegalSection>

      <LegalSection title="Questions">
        <p>Text Aria &ldquo;help&rdquo; and Daniel will get back to you.</p>
      </LegalSection>
    </PlainPage>
  );
}
