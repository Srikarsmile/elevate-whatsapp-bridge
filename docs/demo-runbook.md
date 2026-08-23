# ElevateBox Voice Agent Demo Runbook

## Safety state

- The bridge starts with `CALLBACK_DISPATCH_MODE=disabled`. In this mode, due callbacks are retained and no call request leaves the service.
- `dry_run` exercises validation, scheduling, persistence, and state transitions without contacting Sarvam.
- `live` permits Sarvam Instant Outbound and requires a separate, explicit operator change after reviewing the target number and health checks.
- Only `918639885985` and `918688664337` are accepted as demo destinations.
- No campaign or call is initiated by installation, restart, health checks, feedback evaluation, or recommendation promotion.

## Demo flow

1. Sarvam conducts a short multilingual website-sales conversation.
2. The agent waits for each answer, reflects only useful facts, and asks one question at a time.
3. A callback is created only after the caller gives a specific future time and confirms it.
4. The callback scheduler claims the booking once and persists the claim before dispatch.
5. Sarvam's outcome webhook supplies authoritative call status and transcript data.
6. Hot leads receive the contextual mid-call WhatsApp follow-up; the post-call architecture summary can be sent when requested. The bridge never attaches a resume.

## Callback states

`scheduled` -> `dispatching` -> `dialing` -> `connected | no_answer | busy | failed`

- `disabled`: due work remains `scheduled` because outbound calling is off.
- `dry_run`: records a redacted `callback_dry_run` event, then closes the rehearsal as `expired` with reason `dry_run_completed_without_call`.
- `failed`: a conclusive provider rejection is terminal and requires operator review before any new booking.
- `dispatch_unknown`: a timeout or ambiguous transport failure is quarantined. Never retry it automatically because the provider may already have accepted the call.

## Before any live demo

1. Confirm `/elevate-whatsapp/health` reports the intended dispatch mode, WhatsApp state, scheduler state, and queue counts.
2. Confirm the called number digit-for-digit and verify it is one of the two allowlisted demo numbers.
3. Confirm Sarvam credentials, agent ID, phone-number ID, and outcome webhook token are present without printing their values.
4. Confirm the WhatsApp transport is connected if the demo includes a follow-up message.
5. Run `npm test`, `npm run test:integration`, and `npm run check` on the exact release.
6. Start with `CALLBACK_DISPATCH_MODE=dry_run`, create one future booking, and verify the dry-run record.
7. Return the service to `CALLBACK_DISPATCH_MODE=disabled` after the rehearsal.
8. Change to `live` only with fresh approval immediately before the call. Restarting the service alone must never place one.

## Conversation behavior

The agent uses a neutral identity and does not invent a caller name. It waits for speech, accepts interruption, avoids stacked questions, and follows the caller's Telugu, Hindi, English, or code-mixed language. It captures business type, product count, required features, budget, timeline, decision authority, objections, buying signals, and an optional callback time. It never claims a callback or WhatsApp delivery succeeded unless the tool response confirms it.

## Feedback loop

The loop is governed rather than self-editing:

1. Sarvam events and transcripts are stored with phone numbers redacted.
2. A deterministic evaluator checks listening, interruption handling, one-question turns, callback confirmation, fabricated facts, and tool-result honesty.
3. The separate tool-free Hermes worker scores the same fixed rubric. It receives only the bounded transcript payload and has no shell, network, or bridge tools.
4. Low scores become regression cases. Critical reliability failures open a recommendation immediately; style changes require evidence from two distinct calls.
5. A human reviews the evidence with `npm run recommendations -- list` and `npm run recommendations -- show <id>`.
6. `approve`, `reject`, and `promote` only change recommendation state. They do not edit the prompt, restart services, enable `live`, send WhatsApp, or initiate a call.

Raw transcript and event records are retained for 30 days. Evaluation cases keep only bounded excerpts and numeric evidence required for regression review.

## Assignment coverage

| Requirement | Evidence |
| --- | --- |
| Automatic outbound call | Durable callback scheduler plus Sarvam Instant Outbound adapter |
| Telugu, Hindi, English, mixed language | Sarvam multilingual voice configuration and transcript review |
| Listening and interruptions | One-question prompt rules and deterministic turn checks |
| Website sales discovery | Structured lead fields captured during the call |
| Hot, Warm, Cold classification | Persisted intent output with post-call evaluation |
| Mid-call WhatsApp | Authenticated, allowlisted message endpoint |
| Spoken callback booking | Confirmed time, durable booking ID, and explicit dispatch states |
| Post-call material | Contextual WhatsApp message and architecture diagram; no resume attachment |
| Contact number | `+91 86398 85985` in the diagram and approved follow-up content |
| Continuous improvement | Deterministic checks, tool-free Hermes scoring, regression cases, and human approval |

## Recovery

- If WhatsApp is disconnected, do not promise message delivery. Relink it before the demo.
- If Sarvam returns a conclusive rejection, inspect the recorded error before one controlled retry.
- If a booking enters `dispatch_unknown`, check Sarvam call logs and reconcile it manually. Do not redial automatically.
- If the worker is unavailable, deterministic evaluation continues and Hermes jobs remain queued.
- If a recommendation is wrong, reject it. The running voice agent remains unchanged throughout review.
- After any live test, restore `CALLBACK_DISPATCH_MODE=disabled` and confirm health before leaving the system unattended.
