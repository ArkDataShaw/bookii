# Bookii — Product & Technical Specification (v1)

*A modern, invitee-first, agent-native calendar booking system.*
*Spec v1 — synthesized from deep research on Calendly, Cal.com, SavvyCal, Chili Piper, Acuity, Vimcal, Reclaim, Zeeg, TidyCal, and community sentiment (G2, Trustpilot, Reddit, HN).*

---

## 0. Thesis

The scheduling market's **functional** problems are solved. Its **emotional and trust** problems are not:

1. **The etiquette problem** — a booking link feels like "get in line at my kiosk." (Sam Lessin discourse, 2022.) Only SavvyCal seriously addressed it.
2. **The trust problem** — surprise renewals, refund refusals, bot-walled support, confirmations landing in spam, vendor branding plastered on *your* client experience.
3. **The fragmentation problem** — people are 2–4 calendars now (work Google + personal iCloud + client Outlook). Calendly dropped iCloud for new users in 2024. Nobody bundles true multi-provider identity + booking.
4. **The agent problem** — AI assistants increasingly do the booking. Every incumbent bolts agents on; nobody is agent-native from day one.

**Bookii's position:** the booking page that makes *both* people feel like peers, that any calendar can feed, and that any AI agent can use as fluently as a human.

Headline metric we optimize: **show rate** (booked → attended), not bookings created.

---

## 1. Product Pillars

### Pillar A — Invitee-first booking ("it feels like a conversation, not a kiosk")

- **Calendar overlay**: invitee can one-click connect their own calendar (Google/Microsoft/Apple) and see their busy times superimposed on the host's availability. No account needed; OAuth grant is ephemeral (free/busy read only, discarded after booking).
- **Ranked availability**: hosts mark preferred times; the page renders them as "works best" — softer than hard availability, reads as suggestion not command.
- **Human page**: host face/video intro, welcome message, personal slug (`bookii.to/shaw/coffee`). Typeform-level visual quality.
- **Timezone certainty**: giant, unmissable timezone confirmation on slot select ("2:30 PM in Austin — 9:30 PM for Shaw in Lisbon"), both parties' local times shown side by side on confirmation. Auto-detect + city search override.
- **Zero-friction flow**: no invitee login ever, 3 clicks to booked, month-view + slots on one screen, instant `.ics` + native calendar invite, one-click reschedule/cancel with no login.
- **Mutual mode**: for peer scheduling, either party can propose 2–3 times ("first confirm wins" — Fantastical Proposals pattern); poll mode for groups (Doodle, minus the ads and enshittification).

### Pillar B — Multi-calendar identity

- Connect unlimited calendars: **Google, Microsoft 365/Outlook, Apple iCloud (CalDAV), generic CalDAV, ICS-subscribe** — on every tier, including free.
- **Selected calendars** (read busy from) vs **destination calendar** (write bookings to), per event type.
- **Privacy-masked mirroring** (CalendarBridge's unbundled trick, bundled): mirror busy blocks between calendars as "Busy" holds without leaking event details.
- Busy-time cache + webhook invalidation (Google `events.watch`, Graph subscriptions, CalDAV ctag polling) — availability pages render <300ms.

### Pillar C — Host protection (computed availability)

- Availability = working hours ∩ ¬busy − buffers − min notice − daily/weekly caps, computed per Cal.com's proven pipeline, plus:
- **Overload protection**: meeting caps per day/week, focus-block clustering (prefer slots adjacent to existing meetings to preserve contiguous free time — Clockwise's dead idea, resurrected as a slot-ranking heuristic).
- **Flexible holds**: limits become virtual busy blocks (Cal.com LimitManager pattern).
- **Copy Availability** (Vimcal's beloved snippet flow): select a range → get formatted plain text ("Wed 2–4pm CT / Thu morning") with a booking-link fallback, because most scheduling still happens in email prose.

### Pillar D — Agent-native from day one

- **Public machine surface at the same URL as the human page**: every booking page serves `Accept: application/json` with structured availability; `/.well-known/agent.json` A2A card; `llms.txt`; schema.org `ReserveAction` markup; OpenAPI spec.
- **Two-phase booking**: `POST /v1/slots/hold` (TTL reservation) → confirm. Agent-safe, race-free — the auth/capture pattern.
- **MCP server** (Streamable HTTP + OAuth 2.1): tools for slots, holds, bookings, reschedules, event types.
- **Agent trust tiers**, not CAPTCHAs: Web Bot Auth (RFC 9421) signature verification → verified-agent tier; verified principal email → standard tier; anonymous → rate-limited + email-confirm tier. Every agent booking carries the *principal's* identity ("booked by Claude on behalf of jane@acme.com") — displayed to the host.
- **iTIP semantics**: COUNTER/DECLINECOUNTER model time negotiation for agent-to-agent and email flows; iMIP for email interop.

### Pillar E — Team & CRM (Chili Piper for the 99%)

- **Ownership-first routing**: booking form / routing form checks CRM — existing account owner gets the meeting; round-robin is the *fallback*, not the default.
- **Honest round-robin**: pool combined availability, *then* assign (fixes HubSpot's show-only-one-rep's-slots flaw); weighted, ramp-reduced, capacity-aware; cancellations/no-shows refund round-robin credit.
- **Form Concierge lite**: qualification form → live calendar on the same screen, at SMB pricing, not $15K/yr.
- **CRM sync**: HubSpot, Salesforce, Pipedrive, Attio, Close — contact create/update, meeting activity with reschedule/cancel/**no-show** lifecycle, form answers field-mapped. (Pipedrive/Close/Attio natively — the underserved trio.)
- **No-show machinery**: attended/no-show as first-class booking status, show-rate analytics by rep/source, SMS + email reminder sequences, reconfirmation requests, optional deposits (Stripe) with grace periods.

### Pillar F — Trust as a feature

- Confirmations from **your domain** (custom SMTP/domain on paid tiers) — spam-folder deliverability is a headline feature.
- **No vendor branding on invitee-facing surfaces, even free tier.** (Branding lives in a tasteful "powered by" footer link the host can remove at $0 by verifying a domain — growth loop without hostage-taking.)
- Humane billing: renewal reminder emails, one-click cancel, pro-rated refunds. This is marketing.
- Invitee spam controls: hosts can block emails/domains; booking pages can require email verification.
- EU data-residency option (Zeeg's wedge, neutralized).

---

## 2. Feature Set (table stakes — must match Calendly parity)

- Event types: 1:1, group (seats), collective (intersect hosts), round-robin, managed/locked templates, secret events, one-off links, single-use links, polls.
- Scheduling controls: buffers, min notice, date-range/rolling windows, slot increments, daily caps, multiple durations, multiple location options (Zoom/Meet/Teams/phone/in-person/custom — invitee picks).
- Workflows: email/SMS reminders, follow-ups, reconfirmations; branded sender; two-way SMS; no 180-char caps.
- Integrations: Zoom/Meet/Teams auto-links; Stripe payments (deposits, no-show fees); Zapier/Make/webhooks (`booking.created/rescheduled/cancelled/no_show`, `routing_form.submitted` even without booking).
- Embeds: inline, popup, floating widget; UTM passthrough; prefill; post-booking redirect with event params.
- Admin: teams, roles, SSO **included at team tier** (no $15K cliff), audit log, domain claim.
- Analytics: bookings, show rate, time-to-meeting, popular times, top performers, funnel (page view → slot select → booked → attended).
- Apps: web-first responsive (mobile = first-class), browser extension (insert availability into email/LinkedIn), iOS/Android later.

## 3. Pricing (wedge)

| Tier | Price | Contents |
|---|---|---|
| Free | $0 | Unlimited event types, unlimited connected calendars, reminders, 1 user. "Powered by" footer removable via domain verification. |
| Pro | $10/user/mo | Custom domain + SMTP, SMS workflows, payments, polls, routing, priority human support. |
| Team | $16/user/mo | Round-robin, ownership routing, CRM sync, SSO/SCIM **included**, analytics. |
| No Enterprise cliff. | | Data residency + HIPAA as add-ons, self-serve. |

Anti-gates: never gate number of event types, calendar connections, or reminders. Never show ads to invitees. Never charge per connected calendar.

---

## 4. Architecture

### 4.1 Stack

- **TypeScript monorepo** (Turborepo): `apps/web` (Next.js App Router), `apps/api` (NestJS or Hono — REST v1 + MCP), `packages/core` (availability engine — pure, dependency-free, heavily tested), `packages/adapters` (calendar providers), `packages/ui`.
- **Postgres + Prisma**; Redis for slot cache + holds; Temporal or BullMQ for jobs (webhook renewals, reminders, CalDAV polling).
- Timezones: store IANA strings everywhere; UTC instants; expansion in schedule TZ; render in viewer TZ. Temporal API / Luxon.

### 4.2 Core schema (concepts)

- `User`, `Team`, `Membership`, `Host` (join: event type × user, priority + weight)
- `CalendarConnection` (provider, encrypted credentials) → `SelectedCalendar[]` (read) + destination calendar (write)
- `Schedule` (named, TZ) → `AvailabilityRule[]` (`days[], start, end`) + `DateOverride[]` (date-keyed; null = blocked)
- `EventType` (duration(s), locations[], buffers, minNotice, limits, seats, schedulingType: SOLO|COLLECTIVE|ROUND_ROBIN, bookingFields[], preferredWindows[])
- `Booking` (status: pending|confirmed|cancelled|no_show|attended; principal + agent identity) → `Attendee[]`, `BookingReference[]` (remote calendar event IDs)
- `SlotHold` (TTL reservation; unique on host+timerange)
- `RoutingForm` → `RoutingRule[]` (field predicates → event type | host | URL | disqualify)
- `Workflow` → `WorkflowStep[]` (trigger, offset, channel, template)
- Double-booking prevention: Postgres `tstzrange` + GiST **exclusion constraint** on confirmed bookings per host (the layer Cal.com notably lacks) + SlotHold at UX layer + transactional revalidation.

### 4.3 Availability pipeline

```
slots = grid(slotInterval over expand(scheduleRules ∪ dateOverrides, window, scheduleTZ))
        ∩ ¬( providerBusy(selectedCalendars, cached) ∪ ownBookings±buffers
             ∪ virtualLimitBlocks ∪ activeHolds )
        − (now + minNotice)
→ rank(preferredWindows, clusteringHeuristic)
→ intersect(hosts) | roundRobinPick(weights, credits)
→ present(viewerTZ)
```

### 4.4 API surface

- `GET /v1/pages/:slug` — page metadata (human page serves HTML; `Accept: application/json` → same data structured)
- `GET /v1/slots?eventType&start&end&tz` — public, cached, policy-applied
- `POST /v1/holds` → `{holdId, expiresAt}` ; `POST /v1/bookings {holdId, attendee, answers, principal?, agent?}`
- `PATCH /v1/bookings/:uid` (reschedule → COUNTER semantics), `DELETE` (cancel)
- Webhooks with HMAC signatures. OpenAPI published. MCP mirrors these as tools.

---

## 5. UX Specification (the part that wins)

### Booking page (invitee)
1. **Hero strip**: host avatar/video, name, event title, duration, location chips, welcome line. Warm, personal, fast (<1s LCP; static-render + hydrate slots).
2. **One screen**: month calendar left (available days dotted), slot column right (mobile: stacked, day picker → bottom-sheet slots). "Works best" slots subtly badged.
3. **Overlay CTA**: "See your calendar on this page" — one-click OAuth, busy blocks ghost-rendered over slots.
4. **Slot select** → inline form (name, email, custom fields; returning invitees autofilled) + unmissable dual-timezone confirmation line.
5. **Confirmed**: instant screen with add-to-calendar buttons, reschedule/cancel links, host's note. Email from host's domain.
6. Speed & keyboard: full keyboard nav, `j/k` days, `enter` book. Prefill via query params.

### Host app
- **Onboarding**: connect calendar(s) → pick working hours (visual weekly painter) → first event type auto-created → share sheet with link + QR + embed snippet. Under 3 minutes.
- **Dashboard**: today's meetings, show-rate stat, upcoming, quick-copy availability snippet tool.
- **Event type editor**: live preview right pane (edit left, invitee view right, always in sync).
- **Availability editor**: visual week grid painting + date overrides calendar; per-schedule TZ.
- Mobile: bottom-tab nav (Today / Bookings / Share / Settings), all editors usable on a phone.

### Design language
- Distinctive, not Calendly-clone: editorial typography (a serif display face for host names / humanist sans for UI), generous whitespace, one accent hue per host (host-pickable, drives the whole page theme), soft depth, dark mode.
- Motion: slot columns slide, holds pulse gently, confirmation is a satisfying moment (not confetti-cringe; a calm "it's done" state).

---

## 6. Prototype Scope (this build)

Static-deployable (Netlify) functional prototype:
- Invitee booking flow: landing → booking page (month grid + slots, overlay demo, dual-TZ, form, confirmation) — fully interactive with a real client-side availability engine (TS, working hours ∩ busy − buffers − notice) and localStorage persistence.
- Host dashboard: today view, bookings list, event-type editor with live preview, availability painter, integrations panel (mock connections), analytics tiles.
- Agent surface demo: `/agent` page showing the JSON slots feed, MCP tool list, and a simulated "Claude books on behalf of…" flow.
- Killer responsive UI, desktop + mobile.

## 7. Later (out of prototype scope)

Real OAuth/CalDAV sync, MCP server, CRM connectors, payments, SMS, browser extension, native apps, EU residency.
