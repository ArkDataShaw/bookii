# Bookii — Complete Page Inventory & Build Plan

*Compiled 2026-07-21 from four research passes: Calendly/Cal.com app sitemaps, marketing/legal/trust
comparables (SavvyCal, Plausible, Fathom, Buttondown), the full invitee lifecycle, and
settings/billing/team/developer surfaces. Gap-mapped against what Bookii has today.*

## Already built ✅

Marketing landing (bookii.to) · app auth (signup/login) · onboarding (username claim) ·
event types list + editor (draft mode, live preview) · availability (schedules, weekly painter,
date overrides) · meetings list with status tracking · calendar connections (Google flow complete,
awaiting creds) · public profile + booking page (hold→confirm) · confirmed screen + .ics ·
cancel-by-token · agent surface (/api/slots, llms.txt, agent.json, openapi.json) · whitelabel
tenant on app.bookii.to.

---

## P0 — The OAuth gate + invitee table stakes (blocks Google verification & real usage)

**Legal/trust trio (hard Google OAuth verification requirements):**
1. **Privacy policy page** — must be live, on bookii.to, linked from homepage, and explicitly
   disclose how Google user data is accessed/used/stored. *Blocks OAuth verification.*
2. **Terms of service page** — required for OAuth branding; linked from homepage.
3. Homepage must describe the app (already does) + link both. Footer links needed.

**Invitee lifecycle gaps (research: "table stakes, pairs with existing cancel token"):**
4. **Reschedule-by-token page** — reuse booking UI + "former time" crossed out banner + reason
   field; updates the booking in place (not cancel+rebook). The #1 missing invitee surface.
5. **Edge-state pages**: branded event-not-found (link to host profile if host exists),
   no-slots state with "next available: [date]" jump (do better than Calendly's dead end),
   slot-taken race recovery (inline "pick another," never a dead end).
6. **Confirmation upgrades**: Google/Outlook/Yahoo add-to-calendar deep links beside .ics;
   "book another" link. Cancel page: reason field + rebook prompt.
7. **Cancel/reschedule notices to host** — email surfaces (see P1 emails).

**App gaps at the same tier:**
8. **Booking-status tabs** on Meetings (upcoming/pending/past/cancelled) — the page hosts
   live in daily; deepest daily-use ROI.
9. **Settings: Profile/General page** — name, username (with link-break warning + live URL
   preview), welcome note, timezone, email; **account deletion** (GDPR-required day one).
10. **Notification toggles** (minimal): new booking, cancellation, daily agenda on/off.

## P1 — Retention & credibility (first month after sync ships)

**Email set (design as first-class surfaces — currently we send nothing):**
booking confirmation w/ .ics + reschedule/cancel links · host new-booking notice ·
cancellation notice (both sides, who cancelled, rebook link) · **reschedule notice designed to
not read as a cancellation** (top Calendly complaint) · 24h/1h reminders (no-show machinery) ·
email verification / password reset.

**Trust surfaces (every bootstrapped comparable ships these):**
status page (Instatus/BetterStack hosted) · `/.well-known/security.txt` + security@ ·
changelog page · contact/support page.

**App:**
- **Availability troubleshooter** (Cal.com's support-ticket killer — overlay computed
  availability vs busy blocks, "why isn't my slot showing").
- **Appearance page**: booking-page theme/brand color with live preview; "powered by" removal
  as the paid gate later.
- **Embed generator** + invitee embed modes (inline/popup/element-click, prefill + UTM params) —
  distribution lever, "cheap, high-leverage" per research.
- **Docs/help center v1** (~10–15 articles): connect calendar, availability troubleshooting,
  event types & sharing, embeds, reschedule/cancel, billing FAQ.
- **Onboarding checklist** on dashboard (activation lever both leaders use).
- Host controls: disable invitee cancel/reschedule per event type + cancellation policy text
  (consider *enforced* time windows — neither leader enforces; differentiator).

## P2 — Monetization + growth engine

**Billing:** plans page → Stripe Checkout · billing overview → **Stripe-hosted customer portal**
(don't build custom) · trial banner with graceful degradation (booking pages never go dark —
punishing invitees is uniquely bad for a scheduling product) · dunning banner w/ deadline.

**Marketing/SEO (proven traffic order):**
1. **Integration landing pages** (`/integrations/{slug}`) — the category's proven SEO engine
   (Calendly's ~1.1M/mo organic).
2. **Comparison pages** — `/calendly-alternative` first (highest intent), then per-competitor.
3. **Solutions/persona pages** (~7, SavvyCal-scale: sales, recruiting, consulting, CS…).
4. Pricing page · about · blog · free tool (timezone converter — linkable asset).

**Legal growth:** DPA (self-serve) + subprocessors list (B2B procurement asks fast for a tool
holding invitee PII) · security practices page · cookie policy only if we add non-essential
cookies (stay cookieless like Plausible/Fathom and skip the banner).

**Invitee:** payment step (Stripe, blocks confirmation; failure returns to form without
orphaning the hold) · seats/group events (remaining-seat badge, seat-scoped tokens) ·
pending/approval state ("requires confirmation" event types).

**Auth:** magic-link login (natural fit) · "Sign in with Google" identity-only, then
**incremental authorization** to add calendar scopes during onboarding (unified feel, faster
Google review) · forgot/reset password · email verification.

**Internal admin:** user lookup screen (first tool to build) · impersonation with Cal.com's
user-facing opt-in toggle pattern + audit log.

## P3 — Teams & power users (Phase 3 of the spec)

Teams: create team (slug/logo) · members + invites (email + link, pending) · roles
(Owner/Admin/Member only — resist granularity) · team event types (collective/round-robin/
managed) · round-robin config (per-host priority + weight sliders; ownership-first per spec) ·
team availability view · team booking page (`/team/{slug}`).

Workflows: list + editor (trigger → email/SMS steps, offsets) — "the single most-cited
'why I pay' feature."

Routing forms: list + builder (rules → event type/URL/disqualify) + responses table.

Developer: API keys (show-once, prefix+last-4, last-used) · webhooks page (event checkboxes,
HMAC secret, **test ping + delivery log with replay** — the #1 support deflector) ·
**Agent access page**: scoped tokens (read-availability / create-booking / manage-event-types)
+ agent action audit log — cheap, differentiating, on-thesis.

Insights/analytics: bookings funnel, show rate by source (our headline metric), popular times.

Polls/mutual mode invitee surfaces: vote page, vote-recorded, finalized (winner + add-to-cal),
expired.

Post-meeting: follow-up email w/ rebook link · no-show rebook email · one-click rating page
(tokenized — **nobody major does this; open differentiator**) · waitlist for full group events
(only Acuity does it; differentiator).

## P4 — Enterprise / later

Custom domains for hosts (CNAME+TXT verify flow, auto-TLS) · custom SMTP/email white-label ·
SSO/SAML (email-first detect) · SCIM · OAuth app registry · fine-grained RBAC · audit logs ·
2FA + sessions/devices page · out-of-office (with forward-to-teammate) · data export (async
GDPR Art. 20) · localization (65-lang browser-detect + host override; logical-CSS RTL from
day one on new surfaces) · WCAG 2.1 AA pass on booking pages (keyboard grid nav, ARIA,
focus management in embeds).

---

## Where hosts actually live (frequency data → invest accordingly)

Daily: **meetings/bookings list** (the #1 lived-in page, both leaders) → deepen booking detail
(answers, reschedule/cancel actions, no-show) before adding new sections. Setup-once:
everything else. Rare: analytics, admin.

## Notable "nobody does this" openings surfaced by research

1. Enforced cancellation/reschedule windows (leaders display policy text but don't enforce)
2. Invitee rating page (one-click, tokenized)
3. Waitlist for full slots (only Acuity, not meeting schedulers)
4. "Next available" hint on empty calendars (Calendly's dead end)
5. Agent access tokens with per-action scoping + audit log (Cal.com has MCP but not scoped
   agent token UX)
