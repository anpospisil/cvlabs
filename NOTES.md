# Running notes — assumptions, edge cases, decisions

Status key: [D] decided · [?] open · [GAP] known gap, documented not built

## Identity & matching
- [D] Email (trimmed and lowercased) is the main identifier. Phone (E.164) is secondary; households share phones, so a phone match alone never merges two people. Names are used only to spot conflicts.
- [D] Provider `lead_reference` (lead_id / submission_id) is trusted for calls and SMS events, because those IDs are ours.
- [D] Same `event_id` means a redelivery: ignore it and log it. Different `submission_id` from the same person and service while an inquiry is open: attach it to that inquiry, with no new owner or task.
- [D] L1001 and L1002 share a phone but have different names and emails: two people, no merge and no reassignment. Flag the shared phone on SMS.
- [D] Show the shared phone on the card (`shared_phone_with`). The rep's next action is a neutral household question ("Is anyone else in your household also working with us?"). Never name the other person: that would disclose their inquiry.
- [GAP] Household link button: it proposes consolidating to one eligible rep. It needs consent from both people and a handoff agreed between the two reps (review or manager task). Production step, not built.
- [GAP] Email validation on the website form: out of scope. The server normalizes emails at ingestion (trim, lowercase).
- [D] Distribution: `assigned_today` replaces "least active cases", because the active caseload isn't in the data.
- [?] F103 (Riley Taylor): the email is new, but the phone is Avery Stone's (L1004). Recommendation: unclear match, so a review task with no owner.
- [?] F104 (Jordan Lee): the email matches L1001, but the phone is L1004's (Avery) and the service is different. Recommendation: unclear match, so a review task. Immigration and inadmissibility data is sensitive, and a wrong merge exposes one person's case to another.
- [GAP] No fuzzy or name matching, no merge tool.

## Ownership & routing
- [D] Ownership sits on the **service inquiry** (person × service). The person record holds identity, permissions, suppression and contact history.
- [D] New inquiry: the eligible, available rep with the lowest `assigned_today` gets it. Ties go to the lowest rep id. Each assignment adds 1 to that rep's count.
- [D] Multi-unit reps: `assigned_today` is a total across all units, so their load is spread across units automatically. Accepted trade-off.
- [D] Same-service return: keep the owner. If the owner is unavailable, the owner stays the relationship owner, and the first-call task goes to a **covering** rep (eligible, available, least-loaded). The owner is notified. Coverage never replaces the owner silently.
- [D] Different-service return: keep the existing inquiries untouched. Reuse the person's existing owner if that rep is eligible and available (for continuity); otherwise use the least-loaded rule.
- [D] No eligible rep available: the inquiry goes to an unassigned queue, and an escalation task goes to the sales manager. It is never assigned to an ineligible rep. (The data never triggers this; it is covered by a unit test.)
- [D] Don't create a second first-call task while one is open for that inquiry.

## Contact & SMS
- [D] Only `voicemail_left` can trigger an SMS. Busy, completed and null outcomes record a reason.
- [D] Permission is granted / revoked / unknown. Leaving it out of a submission changes nothing.
- [D] STOP suppresses every SMS to that **phone**, across all reps, services and people sharing it. A new submission without new permission does not clear it.
- [D] Eligibility is checked when the decision is made, against current state. That includes a STOP that arrived late but happened earlier.
- [D] Window: 09:00–18:00 in the recipient's local time, checked at processing time (`received_at`).
- [D] Unknown timezone: no automated SMS. The task tells the rep to confirm the timezone. The area code is not used.
- [D] `{{rep_name}}` is the rep who made the call, assumed to be the current task assignee. Call events don't name a rep (see GAP below).
- [D] Idempotency key for a send is `related_call_attempt_id`: at most one SMS per call attempt.
- [GAP] Calls are not attributed to a rep in the events. In production, use the Close or RingCentral user id.

## Delivery tracking
- [D] Message states are created → queued → accepted/sent → delivered | failed (delivered and failed are final). A late or lower-ranked update is logged in history but does not move the state backwards (E009 queued arriving after E008 delivered).
- [D] `failed` creates exactly one review task per message, even if failures repeat.
- [D] `delivered` means the carrier handed it to the handset. It is not a conversion; a reply or booking is.

## Data observations (for the README and demo)
- E002 is redelivered at 15:02:40: same event_id, so a webhook retry, not a double click. The double submit is F100 + F101.
- E009 *happened* at 15:05:04 but was *received* at 15:09: an out-of-order update.
- E012 STOP happened at 15:01 and was received at 15:12. The E013 voicemail happened at 15:04 and was received at 15:13, so it gets suppressed. If the order of arrival had been reversed, a text would have gone out after a STOP. Production idea: a short send delay or a re-check.
- L1004 (Avery, Los Angeles) was called at 15:10Z, which is **07:10 PT**: outside the 09:00 window. Flag it.
- I102 has two attempts on two providers (Close busy → RingCentral completed). The interaction outcome is conversation_completed.
- Close sending number +12025550180: business verification and messaging registration are "not_provided". Hypothesis: the 30007 carrier filtering on M101 is related to that (unregistered A2P / 10DLC). Not confirmed.
- RingCentral +14165550181: SMS capability not_provided, so it is not used for SMS.
- F105 Drew Ellis: timezone null.

## Expected run (this is the test spec)
| Event | Expected |
|---|---|
| F100 Taylor Reed (citizenship) | new person; owner REP07 (9 is the lowest; becomes 10); first-call task |
| F101 / E002 retry | attach to the F100 inquiry / ignore |
| F102 Casey Lee | L1002, same service, keep REP04, call task |
| E004 C100 voicemail | SMS M100 sent (granted, 10:05 ET, no STOP) |
| E005 C101 voicemail L1002 | SMS M101 sent, shared-phone warning |
| E006/E007 M101 | accepted → failed 30007 → 1 review task for REP04 |
| E008/E009 M100 | delivered; late queued is logged and ignored |
| E010/E011 L1004 | busy → completed; no SMS; outside-window flag |
| E012 STOP | phone +14165550102 suppressed |
| E013 C104 voicemail L1003 | SMS suppressed: STOP |
| F103 Riley Taylor | review task (phone conflict with L1004) |
| F104 Jordan Lee | review task (email L1001 vs phone L1004) |
| F105 Drew Ellis | new, REP07 (10 → 11), timezone unknown flag |
| F106 Morgan Patel (inadmissibility) | REP07 not eligible → REP05 (10 → 11); work_permits/REP07 kept |
| F107 Casey Lee (inadmissibility) | reuse REP04 (eligible + available) |
| E019 C105 voicemail F106 | SMS suppressed: STOP carries across services |
| F108 Jordan Lee (citizenship) | owner REP03 unavailable → stays owner; covering rep REP07; REP03 notified |
