# Bookii

**The booking page both of you will like.** An invitee-first, multi-calendar, agent-native
calendar booking system — research, full spec, and a working prototype.

Live: **https://bookii.to**

## The one scene

A human and an AI agent book against the **same live availability**, with slot holds arbitrating:

1. Open [the booking page](https://bookii.to/#/book) in one window.
2. Open [the agent console](https://bookii.to/#/agent) in a second window and hit **Run**.
3. Watch the agent's hold pulse apricot on the human's page in real time, then resolve into a
   booking with visible provenance ("held by Claude · confirmed by jane@acme.com") in the
   [host view](https://bookii.to/#/host).

The agent surface is real: `curl "https://bookii.to/api/slots?date=2026-07-21&tz=America/Chicago"`
runs the same availability engine (`engine.js`) as the human page, via a Netlify Function.
Also served: [`/llms.txt`](https://bookii.to/llms.txt),
[`/.well-known/agent.json`](https://bookii.to/.well-known/agent.json),
[`/openapi.json`](https://bookii.to/openapi.json).

## What's here

| Path | What |
|---|---|
| `docs/SPEC.md` | Full product + technical spec (v2, post-critique) |
| `docs/SPEC-v1.md` | First pass, kept for the diff |
| `engine.js` | Pure availability engine — working hours ∩ ¬busy − buffers − min notice − caps; shared by browser and Netlify Function |
| `index.html` / `styles.css` / `app.js` | The prototype: invitee page (calendar overlay, dual-timezone, hold pulses), agent console, host strip, mutual-mode proposals |
| `netlify/functions/slots.js` | Live `GET /api/slots` |

## Why (the 10-second version)

Scheduling's functional problems are solved; its **emotional and trust** problems aren't:
booking links feel like "get in line at my kiosk," people are 2–4 calendars now, billing and
support hostility drive all the switching, and AI agents increasingly do the booking while
every incumbent treats them as an afterthought. Bookii's spec answers all four — see
[docs/SPEC.md](docs/SPEC.md), built from deep research into Calendly, Cal.com, SavvyCal,
Chili Piper, Acuity, Vimcal, Reclaim, and thousands of G2/Trustpilot/Reddit datapoints.

## Prototype notes

Bookings, holds, and proposals persist in `localStorage` and sync across windows
(BroadcastChannel + storage events). No build step; deployable anywhere static + one function.
