# Bookii — Product & Technical Specification (v2, final)

*A modern, invitee-first, agent-native calendar booking system.*
*v2 — rewritten after independent review. Changelog vs v1 at bottom.*

---

## 0. Thesis

The scheduling market's **functional** problems are solved. Its **emotional and trust** problems are not:

1. **Etiquette** — a booking link reads as "get in line at my kiosk." Only SavvyCal seriously addressed it.
2. **Trust** — surprise renewals, bot-walled support, confirmations in spam, vendor branding on *your* client experience.
3. **Fragmentation** — people are 2–4 calendars now. Calendly dropped iCloud for new users. Nobody bundles multi-provider identity + booking.
4. **Agents** — AI assistants increasingly do the booking. Incumbents bolt agents on; nobody is agent-native from day one.

**Position:** the booking page that makes both people feel like peers, that any calendar can feed, and that any AI agent can use as fluently as a human.

**Headline metric: show rate** (booked → attended). Note the deliberate tension: agent bookings could lower show rate. Resolution: agent-initiated bookings default to a reconfirmation step for the principal, and show-rate analytics segment human vs agent origin. Meetings that *happen* is the axis no incumbent owns.

**Beachhead ICP:** the solo professional / prosumer (consultant, founder, recruiter, coach) who cares how the booking link makes the other person feel — the same person who has an AI assistant. Team/CRM capability is specced (Phase 3) but is not the launch funnel.

## 0.1 Go-to-market

- The **invitee overlay moment is the growth loop**: after seeing their own calendar on someone else's page, the invitee gets "want this for your meetings?" The invitee IS the next host.
- **"Powered by Bookii" footer stays on free tier** — it is the category's proven distribution channel, not hostage-taking. Removal is a paid feature. (Reverses v1.)
- Agent channel: being the booking page MCP clients work with out of the box is distribution — directory listings, `llms.txt`, agent-framework example docs all point here.
- Trust-as-marketing: renewal reminder emails, one-click cancel, human support. Calendly's Trustpilot record is the ad copy.

---

## 1. Product Pillars

### Pillar A — Invitee-first booking ("a conversation, not a kiosk")
- **Calendar overlay**: invitee one-click connects **Google or Microsoft** (OAuth, free/busy read-only, ephemeral grant discarded after booking) and sees their busy times ghosted over the host's slots. *iCloud is host-side only — Apple has no calendar OAuth; app-specific-password CalDAV is not an invitee-grade flow.* Google restricted-scope verification (CASA) is a known lead-time item.
- **Ranked availability**: hosts mark preferred windows; rendered as "works best" — suggestion, not command.
- **Human page**: host face/video intro, welcome message, personal slug (`bookii.to/shaw/coffee`).
- **Timezone certainty**: unmissable dual-timezone confirmation at slot select and on the confirmed screen ("2:30 PM in Austin — 9:30 PM for Ana in Lisbon").
- **Zero-friction**: no invitee login, 3 clicks to booked, month + slots on one screen, instant `.ics` + native invite, no-login reschedule/cancel.
- **Mutual mode**: either party proposes 2–3 times; first confirm wins, others auto-retract (specced in §5.3).

### Pillar B — Multi-calendar identity
- Providers: Google, Microsoft 365, Apple iCloud (CalDAV), generic CalDAV, ICS-subscribe.
- **Selected calendars** (read busy) vs **destination calendar** (write), per event type.
- **Privacy-masked mirroring**: mirror busy blocks between calendars as "Busy" without leaking details.
- Busy cache + webhook invalidation (Google watch, Graph subscriptions, CalDAV ctag polling). Availability renders <300ms.

### Pillar C — Host protection (computed availability)
- Working hours ∩ ¬busy − buffers − min notice − caps (Cal.com's proven pipeline), plus:
- **Overload protection**: per-day/week meeting caps; **clustering heuristic** ranks slots adjacent to existing meetings to preserve contiguous focus time.
- Limits as virtual busy blocks (LimitManager pattern).
- **Copy Availability**: select ranges → formatted plain text with booking-link fallback (most scheduling still happens in email prose).

### Pillar D — Agent-native from day one
- **Same-URL machine surface**: booking pages content-negotiate — `Accept: application/json` returns structured page + availability. Plus `/.well-known/agent.json` (A2A card), `llms.txt`, schema.org `ReserveAction`, OpenAPI.
- **Two-phase booking**: `POST /v1/holds` (TTL reservation) → `POST /v1/bookings {holdId}`. Auth/capture for meetings. **`Idempotency-Key` required on all mutating endpoints.**
- **MCP server** (Streamable HTTP + OAuth 2.1): slots, holds, bookings, reschedule, event types.
- **Agent trust tiers, not CAPTCHAs**:
  - Tier 1 (verified agent): Web Bot Auth (RFC 9421) signature → higher rate limits.
  - Tier 2 (verified principal): booking is `pending` until the principal's email confirms — one click. Only then `confirmed` + calendar write. *Principal identity is proven, not asserted.*
  - Tier 3 (anonymous): tight rate limits + email confirm + short hold TTLs.
  - Every agent booking displays provenance to the host: "held by [agent] · confirmed by jane@acme.com."
- **Negotiation is first-class in our API** (propose / counter / accept objects over REST+MCP) — *not* built on iTIP COUNTER, which real clients don't implement. We **emit** standards-compliant iCalendar/iMIP invites; we don't depend on their scheduling semantics.

### Pillar E — Team & CRM (Phase 3: "Chili Piper for the 99%")
- **Ownership-first routing**: CRM owner gets the meeting; round-robin is fallback.
- **Honest round-robin**: pool combined availability, then assign (fixes HubSpot's flaw); weighted, ramp-reduced; cancellations/no-shows refund credit.
- **Form Concierge lite**: qualification form → live calendar same screen, SMB pricing.
- **CRM sync**: HubSpot, Salesforce, Pipedrive, Attio, Close — contact upsert, meeting activity with reschedule/cancel/no-show lifecycle, field-mapped answers. Pipedrive/Attio/Close natively (the underserved trio).
- **No-show machinery**: attended/no_show first-class status, show-rate analytics by rep/source, reminder + reconfirmation sequences, optional Stripe deposits.

### Pillar F — Trust as a feature
- Confirmations from **your domain** (custom SMTP/domain, paid) — deliverability as a headline feature.
- Humane billing: renewal reminders, one-click cancel, pro-rated refunds.
- Invitee spam controls: host blocklists, optional email verification.
- EU data-residency option (paid add-on). **HIPAA: not in v1** — BAA-grade compliance is a later, deliberate program, not a checkbox.

---

## 2. Table stakes (Calendly parity — condensed)

Event types (1:1, group/seats, collective, round-robin, managed, secret, one-off/single-use, polls) · buffers, min notice, windows, increments, caps, multi-duration, multi-location (invitee picks) · workflows (email/SMS reminders, follow-ups, reconfirmation; branded sender; SMS usage-billed — A2P/10DLC registration acknowledged) · Zoom/Meet/Teams auto-links · Stripe (deposits, no-show fees) · Zapier/Make + HMAC webhooks (`booking.created/rescheduled/cancelled/no_show`, `routing_form.submitted` even without booking) · embeds (inline/popup/widget, UTM, prefill, redirect) · teams, roles, **SSO included at Team tier** (SCIM later) · analytics funnel (view → slot select → booked → attended) · responsive web first-class on mobile; browser extension; native apps later.

## 3. Pricing

| Tier | Price | Contents |
|---|---|---|
| Free | $0 | Unlimited event types, **3 connected calendars**, reminders, 1 user, "powered by" footer. |
| Pro | $10/user/mo | Unlimited calendars, custom domain + SMTP, SMS (usage-billed), payments, polls, routing, footer removal, priority human support. |
| Team | $16/user/mo | Round-robin, ownership routing, CRM sync, SSO included, team analytics. |

No enterprise cliff. Anti-gates: never gate event-type count or reminders; never show ads to invitees; never charge per calendar *within* a tier. (Free capped at 3 calendars because CalDAV/ICS polling is the most expensive workload per user — still 3× Calendly's free tier.)

---

## 4. Architecture

### 4.1 Stack
TypeScript monorepo (Turborepo): `apps/web` (Next.js), `apps/api` (Hono/NestJS — REST v1 + MCP), `packages/core` (pure availability engine, heavily tested), `packages/adapters` (providers), `packages/ui`. Postgres + Prisma; Redis as **cache only**; BullMQ/Temporal jobs (channel renewals, reminders, CalDAV polling). IANA TZ strings everywhere; UTC instants; expand in schedule TZ; render in viewer TZ.

### 4.2 Core schema
`User`, `Team`, `Membership`, `Host(eventType×user, priority, weight, rrCredit)` · `CalendarConnection` → `SelectedCalendar[]` + destination · `Schedule(tz)` → `AvailabilityRule(days[], start, end)[]` + `DateOverride[]` · `EventType(durations[], locations[], buffers, minNotice, limits, seats, schedulingType, bookingFields[], preferredWindows[])` · `Booking(status: pending|confirmed|cancelled|no_show|attended; principal, agent)` → `Attendee[]`, `BookingReference[]` · `SlotHold(ttl)` · `RoutingForm` → `RoutingRule[]` · `Workflow` → `WorkflowStep[]` · `Proposal(times[], status)` for mutual mode.

**Holds & double-booking — Postgres is the single source of truth.** `SlotHold` and confirmed `Booking` rows both carry `tstzrange` covered by a **partial GiST exclusion constraint** per host: excludes overlaps among {active holds ∪ confirmed bookings}, ranges **inflated by buffers**, partial to exempt seat-based group events (overlap intentional). Redis only caches computed slot sets.

**Confirm-time pipeline** (the layer where real double-bookings happen — Bookii vs external calendar):
1. Synchronous provider free-busy re-fetch for the booked window (Google freebusy / Graph getSchedule; CalDAV falls back to cache age check).
2. If step 1 times out (>2s): proceed if busy-cache age < 60s, else book as `pending` with host notify (never silently fail the invitee).
3. DB transaction: revalidate policy, insert booking — exclusion constraint is the backstop.
4. Write to destination calendar; store `BookingReference`; fire webhooks.

### 4.3 Availability pipeline
```
slots = grid(interval over expand(rules ∪ overrides, window, scheduleTZ))
      ∩ ¬(providerBusy(cached) ∪ ownBookings±buffers ∪ virtualLimitBlocks ∪ activeHolds)
      − (now + minNotice)
  → rank(preferredWindows, clustering)
  → intersect(hosts) | roundRobinPick(weight, credit)
  → present(viewerTZ)
```

### 4.4 API
`GET /v1/pages/:slug` (content-negotiated) · `GET /v1/slots?eventType&start&end&tz` (public, cached, policy-applied) · `POST /v1/holds` → `{holdId, expiresAt}` · `POST /v1/bookings {holdId, attendee, answers, principal?, agent?}` · `PATCH /v1/bookings/:uid` (reschedule) · `DELETE /v1/bookings/:uid` · `POST /v1/proposals` (mutual mode) · Idempotency-Key on all mutations · HMAC webhooks · OpenAPI published · MCP mirrors as tools. Rate limits: tier1 300/min, tier2 60/min, tier3 10/min.

---

## 5. UX Specification

Parity surfaces in one line each: month-left/slots-right booking page (mobile: day picker + bottom-sheet slots); live-preview event-type editor; visual weekly availability painter; bottom-tab mobile nav; sub-3-minute onboarding (connect → hours → auto-created event type → share sheet). These match the category's best; the ink goes to the three surfaces nobody has:

### 5.1 The overlay (state machine)
- **Pre-connect**: subtle CTA under the slot grid — "See your calendar here · Google · Microsoft". Never a modal, never nagging.
- **Connected**: invitee busy blocks render as ghost stripes across the grid; conflicting slots dim, mutually-open slots brighten. A "both free" filter chip appears.
- **Privacy**: only free/busy is read; the host **never** sees the invitee's calendar — overlay is client-side only. Copy states this on the connect button ("only you see this").
- **Revoke/error**: one-click disconnect chip; grant auto-discarded on booking or page exit; OAuth failure degrades silently to normal page.

### 5.2 The agent-booking card (host side)
When an agent books: host sees a distinct card — agent name + operator, verification tier badge, principal identity + confirmation status ("held by Claude · awaiting jane@acme.com confirm" → "confirmed by jane@acme.com"), and the agent's stated intent sentence. One-tap decline with reason. Trust is *visible*, not implied.

### 5.3 Mutual mode (proposal flow)
- Host (or either peer) picks 2–3 concrete times → sends a proposal link (or agent sends via API).
- Recipient sees a single card: three time buttons, each with dual-TZ display, "none work → open the full calendar" escape hatch.
- First confirm wins: chosen time books instantly; other proposed times auto-retract (holds released); both parties notified. Proposals expire (default 72h) releasing holds.
- Visual: proposal card renders identically in email (static fallback buttons) and on web (live).

### 5.4 Design language
Editorial, not SaaS-generic: serif display face for host names/hero, humanist sans for UI; one host-picked accent hue drives the page theme; generous whitespace, soft depth, dark mode; motion = slots slide, holds pulse, confirmation is a calm "it's done" moment. Keyboard nav exists but is not a headline.

---

## 6. Prototype Scope (this build) — the demo is one scene

**Center: a human and an agent booking against the same live availability, with the hold system visibly arbitrating.**

- **Invitee booking page, full polish**: month grid + slots, overlay demo (simulated invitee calendar), dual-TZ moment, hold-pulse animation, booking form, confirmed state. Real client-side availability engine (working hours ∩ busy − buffers − min notice), shared state.
- **Live agent lane**: an "Agent console" showing an AI assistant (simulated Claude session) hitting the same engine: `GET /slots` → `POST /holds` → the human's page shows that slot **held and pulsing in real time** → agent confirms → booking appears with provenance card. Where hosting allows, back slots/holds with Netlify Functions over the same engine so it's genuinely `curl`-able; otherwise shared client state with the API shapes rendered verbatim.
- **Host strip** (not a dashboard): today's meetings, show-rate stat, copy-availability snippet tool, the agent-booking provenance card.
- **Mutual-mode proposal card**: interactive demo of propose → first-confirm-wins.
- Killer responsive UI, desktop + mobile. localStorage persistence.

**Cut from prototype** (per review): analytics tiles, integrations panel, full dashboard, event-type editor.

## 7. Phasing

- **Phase 1 (launch)**: Pillars A/B/C/F for solo hosts; agent read surface + holds API; Google + Microsoft; Free + Pro.
- **Phase 2**: iCloud/CalDAV host-side, MCP server GA, mutual mode GA, polls, payments, browser extension.
- **Phase 3**: Teams tier — routing, honest round-robin, CRM connectors, SSO.
- **Later**: SCIM, EU residency GA, HIPAA program, native apps.

---

## Changelog v1 → v2 (from independent review)

**Accepted**: confirm-time double-booking pipeline vs external calendars (was the real hole); exclusion constraint made partial + buffer-inflated + covers holds; Postgres authoritative for holds (Redis cache only); invitee overlay scoped to Google/MS (Apple OAuth doesn't exist); CASA verification lead time noted; principal identity now *proven* via confirm-loop (was spoofable); Idempotency-Key + numeric rate limits; iTIP COUNTER dropped as negotiation substrate (emit-only standards); free tier capped at 3 calendars (CalDAV polling cost bomb); HIPAA cut from v1, SCIM deferred; SMS usage-billed with A2P acknowledged; "powered by" footer contradiction resolved in favor of the growth loop; GTM section added; beachhead ICP declared with phasing; UX ink moved from parity descriptions to the three novel surfaces (overlay state machine, agent provenance card, mutual mode); prototype re-centered on the human+agent single scene, dashboard/analytics cut; show-rate vs agent-volume tension addressed (reconfirmation default, segmented analytics).

**Rejected**: "four startups in a trenchcoat — cut Pillar E" — comprehensive scope is deliberate; resolved via phasing instead of amputation. "Keyboard nav is engineer-brained" — kept (cheap, delights the prosumer ICP), demoted from headline. Full free-tier calendar unlimited was defended by reviewer #6 only partially — we split the difference at 3.
