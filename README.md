# CV Labs GTM prototype: inbound lead → owner → call → follow-up text → delivery

A small TypeScript prototype. It replays the sample events, matches each inquiry to a person, assigns an eligible owner, decides whether to send the follow-up text after a voicemail, and tracks delivery. A salesperson can see **who owns each lead, what happened and what to do next.**

## Requirements
**Node.js 22.18 or newer is required.**

## Run it
```bash
npm run ui     # http://localhost:3000: step through events one by one, filter "View as" a rep / review queue / manager
npm start      # the same result as text in the terminal; also writes out/report.html and out/state.json
npm test       # 13 tests (node:test)
```
`data/sample_data.json` is the supplied file, **unchanged**. It is all synthetic; there are no secrets or real data in the repo.

## Approach
- `src/engine.ts` holds all the logic. Every business rule is in one `POLICY` object (text triggers, STOP keywords, contact window, routing switches). Four handlers follow the journey: `onForm` → `onCall` → `onSmsStatus` / `onSmsReceived`.
- `src/view.ts` builds the salesperson cards. `src/server.ts` and `public/index.html` are the UI; `src/cli.ts` prints the text view.
- **Data model:** a person record (identity, SMS permission; STOP is tracked per phone number) and service inquiries (person × service). **Ownership lives on the service inquiry**, so one person can have different owners for different services. Calls, texts, decisions and tasks are attached to the inquiry.
- Every decision writes a plain-language reason into the inquiry's history, which is the "what happened" timeline.

## Key decisions and assumptions (full list in NOTES.md)
- **Which identifiers are trusted:** email (trimmed and lowercased) is the main one. Phone (normalized to +1 format) is secondary; households share phones, so a phone match alone never merges two people. Our own lead and submission IDs in provider events are trusted.
- **Conflicting identifiers mean review, with no owner.** F103 has a new email on Avery Stone's phone. F104 has Jordan Lee's email with Avery's phone. Immigration and inadmissibility data is sensitive, and a wrong merge exposes one person's case to another. The review task tells the reviewer to verify identity without disclosing the other record.
- **Repeats:** a repeated `event_id` is a redelivery and is ignored. A new `submission_id` for an open inquiry of the same person and service is attached to it, with no new task.
- **Distribution:** the eligible, available rep with the lowest `assigned_today` gets the lead (ties go to the lowest ID), and each assignment adds one. Multi-unit reps are counted once across all their units, so their load spreads naturally. `assigned_today` replaces an "active caseload" figure, which isn't in the data.
- **Same-service return:** the owner is kept. **If the owner is unavailable**, they stay the relationship owner, the least-loaded eligible rep *covers* the first call, and the owner gets a notice. **Different service:** existing assignments are untouched; the person's existing rep is reused if eligible and available, otherwise the distribution rule applies. **No eligible rep available:** the inquiry is queued and a manager escalation task is created. It is never given to an ineligible rep.
- **Text eligibility**, checked when the decision is made, against current state:
  1. The call outcome is `voicemail_left`.
  2. No STOP on that phone number, across all reps, services and people sharing it. A new inquiry without new permission doesn't clear a STOP.
  3. Recorded permission is `granted`. A form that doesn't mention permission changes nothing.
  4. The timezone is known. The area code is never used to guess it.
  5. The recipient's local time is between 09:00 and 18:00.
  
  There is at most one text per call attempt.
- **Delivery:** the message states are created → queued → accepted → delivered or failed. "Created" means submitted, not delivered. Updates that arrive late or rank lower are logged but never move the state backwards. A failure creates **one** task for the owner: call or email, don't resend, and ops checks the sending number.
- `{{rep_name}}` is the covering rep or the owner, because call events don't say which rep called.

## Data observations
- E002 arrives twice: a webhook retry, not a double submit. The double submit is F100 + F101.
- E009 "queued" happened at 15:05 but arrived at 15:09, after "delivered".
- The STOP (E012) happened at 15:01 but arrived at 15:12, after the voicemail call it should suppress.
- L1001 and L1002 share a phone: two people, flagged, not merged.
- Avery Stone (Los Angeles) was called at **07:10 local time**, outside the window, so it is flagged.
- Drew Ellis has no timezone.
- The Close sending number has no business verification or messaging registration on file, which is a plausible cause of the 30007 carrier-filtering failure (*a hypothesis, not confirmed*). The RingCentral number has no confirmed SMS capability.

## Tests (`test/engine.test.ts`)
Normalization; redelivery and repeat submissions; least-loaded routing; same-service return; different service (one reassigned, one reused); unavailable-owner coverage; no-eligible-rep escalation; conflicting matches go to review; STOP across services when it arrives late; unknown timezone blocks texts; a repeated call doesn't send a second text; late "queued" doesn't override "delivered"; a repeated failure gives exactly one task.

## Known gaps
- A status update that arrives *before* its message exists is dropped (it should be held and applied later).
- A STOP that arrives after a text was already sent only raises a compliance review. In production: a short delay or a re-check before sending.
- Review tasks can't be resolved from the UI (no link-record or household-link actions, which would need consent from both people). There's no fuzzy matching and no opt-back-in (START) handling.
- A call outside the window only produces a warning. Calls aren't attributed to a rep. Message history is shown in arrival order.
- State is in memory, rebuilt from events on each run. There is no database.

## Next production steps
- **CRM integration:** Close stays the record of truth. Store our person and inquiry IDs on the Close lead, contact and opportunity, and the provider call and message IDs on activities. Webhooks go into a store that ignores repeated event IDs, then a queue, then this engine. Write every decision back as a Close activity or task.
- **Numbers and callbacks:** each rep or team gets a local number. Inbound calls and replies route to the inquiry owner, or to the coverage rep while the owner is unavailable. Set business caller ID and branded calling, and register numbers for STIR/SHAKEN (US caller-ID authentication).
- **Readiness for launch:**
  - US: A2P 10DLC brand and campaign registration (required for business texting from ordinary long-code numbers).
  - Canada: consent records and identification under Canada's anti-spam law (CASL).
  - Confirm what each provider can do (RingCentral SMS?).
  - Store permission with its source and timestamp.
  - Opt-out keywords sync across both providers.
- **Problems:** collect evidence before choosing a fix:
  - Busy calls and falling connection rates: by number, carrier, hour and area code.
  - Spam labels: check the carrier spam-registration portals.
  - Filtered texts: error codes by template and number.
- **Monitoring:** alert on these, and route each alert to ops or the sales manager:
  - Delivery rate below a threshold, or a spike in 30007 errors (ops).
  - Time to first call above the target.
  - Unassigned or escalated inquiries older than X minutes (sales manager).
  - Rising review-queue age.
  - Any text sent to a suppressed number (a page-level incident).

## Time and tools
- Time spent: **2 hours**, including setup and documentation.
- AI assistant: Claude (Anthropic) for reviewing the data, writing code and tests, and drafting docs. I reviewed, ran and verified the output.
