# Savings Showdown

Nolan vs. Aurora: whoever has **saved the most** by the end of summer 2027 wins.
Static HTML in `public/`, Vercel serverless functions in `api/`, Neon Postgres.

## Rules (as built)
- Score = money saved (starting $0 + deposits - spends). **No cap**: $7,000 is only a milestone badge.
- All spending counts against you, **except gas**.
- Dates alternate, starting with Nolan (coin flip). The planner must define the date first: a title and a scope of
  dinner and/or activity and/or sweet treat (optional budget cap and day). Only one date is open at a time; either
  person can mark it done or skipped. **A skipped date does not pass the turn.** A spend linked to a date must fall
  inside its scope.
- Whoever's idea it is pays from their own balance.
- Immunity: said it at the same time -> whole bill splits 50/50 (odd cent to whoever logs it).
- Rock-paper-scissors if one still wants to go; the winner picks **and pays**. *(phase 5)*
- Text the other before spending: logged as a checkbox; spends without it get a "no text first" badge.
- Window: `settings.start_date` (inclusive) to `settings.end_date` (exclusive). Outside it, nothing can be written.
  Seeded dates are **placeholders** (2027-05-15 / 2027-08-23) until both schools publish 2027 calendars.

## Edits, history, backups
- Edit/delete only your own rows. Deletes are soft. Every create/edit/delete writes `audit_log` (before/after) in the
  same SQL statement as the change.
- Daily Vercel Cron snapshot + a "Save snapshot now" button -> `snapshots` table (90 days, then Sundays only).
- Known gap: immunity (split) rows can't be edited/deleted yet (409), since the two halves must change together.

## Setup
1. Vercel: import this repo; add the **Neon** integration (sets `DATABASE_URL`).
2. Env vars: `SESSION_SECRET` (`openssl rand -hex 32`), `CRON_SECRET`. See `.env.example`.
3. Locally, with those in `.env`: `npm i && npm run migrate && NOLAN_PIN=… AURORA_PIN=… npm run seed`.
4. `npm test`.

## Layout
`lib/game.js` pure rules (unit-tested) · `lib/db.js` SQL + audited writes · `lib/auth.js` PIN + signed cookie ·
`api/` endpoints · `public/` the app · `db/schema.sql`.
