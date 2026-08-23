# ElevateBox Voice Agent Demo Runbook

## Current state

- Sarvam agent: `Website Lead Qualification Caller`, draft `v5`
- Voice: Simran; Telugu, Hindi, and English with automatic language switching
- Telephony: Sarvam Vobiz
- Hermes bridge: `https://193-203-163-98.sslip.io/elevate-whatsapp/`
- WhatsApp: linked personal session; health currently reports `connected`
- Callback store: durable, authenticated, idempotent JSON storage on the VPS
- No campaign or call has been started by this setup work

## Before the demo

1. Confirm `GET /elevate-whatsapp/health` returns `{"ok":true,"whatsapp":"connected"}`.
2. Confirm Sarvam shows the authenticated `schedule_callback` and `send_whatsapp_followup` tools.
3. Add the `send_post_call_package` lifecycle hook with `When should this tool run? = on_end`.
4. Commit the agent draft to a new immutable version.
5. Create a one-contact campaign for the approved test number only. Do not start it yet.
6. Keep the assignment campaign for `8688664337` separate from the controlled test.

## Conversation behavior

Priya must wait for each answer, reflect it briefly, and ask one question at a time. She confirms identity first, then captures:

- business type
- approximate product count
- required features
- budget or `not disclosed`
- launch timeline
- decision-maker status
- objections and buying signals

She follows the caller's Telugu, Hindi, English, or code-mixed language. Interruptions stop playback so the caller can speak. A direct exact callback time is read back once and then booked. A WhatsApp follow-up is sent mid-call only for a genuinely Hot lead or an explicit request.

## Expected automation

| Moment | Action | Proof |
| --- | --- | --- |
| Hot intent during call | `send_whatsapp_followup` | Contextual text arrives before hang-up |
| Confirmed callback time | `schedule_callback` | Stable `cb-*` booking ID is returned |
| Call ends | `send_post_call_package` | Summary, architecture PNG, resume PDF, contact number, and note arrive in order |

## Controlled test script

Use a number owned by Srikar. Confirm the called number immediately before starting.

1. Answer in Telugu, switch to English mid-sentence, and interrupt once.
2. Say the business sells clothing, has about eighty products, and needs payments plus inventory.
3. Give a realistic budget and a one-month timeline.
4. Confirm decision-making authority and request WhatsApp details.
5. Ask for a callback at an exact future India time.
6. Verify the agent listens, reflects each fact, sends the mid-call text, and books the callback.
7. End the call and verify the final package and attachments.

## Assignment coverage

| Requirement | Implementation |
| --- | --- |
| Automatic outbound call | Sarvam outbound campaign |
| Telugu, Hindi, English, mixed language | Sarvam multilingual voice settings |
| Listen and handle interruptions | Short turns, interruption enabled, one-question flow |
| Website sales discovery | Structured conversation prompt and output variables |
| Hot, Warm, Cold classification | `intent_level` output and Hot-only tool guard |
| Mid-call WhatsApp | Authenticated Hermes `v1/messages` tool |
| Spoken callback booking | Authenticated Hermes `v1/callbacks` tool |
| Post-call context and files | Hermes post-call message with architecture and resume |
| Mobile number | `+91 8639885985` included in every message |
| Implementation note | VPS environment note, fewer than 200 words |

## Recovery

- If WhatsApp is disconnected, relink the session before any call.
- If a tool returns an error, Priya must not claim success; she says Srikar's team will confirm directly.
- If the call fails, inspect Sarvam call logs before retrying. Do not repeatedly redial.
- Rollback copy: `/srv/elevate-whatsapp-bridge.backup-20260822172341`
