# Scheduler Report

## Actual deployment configuration

`vercel.json`:
```json
"crons": [{ "path": "/api/internal/jobs/daily-sweep", "schedule": "0 12 * * *" }]
```

One cron, once per day, 12:00 UTC. Confirmed via a live manual trigger of this exact endpoint on 2026-10-25 (production), which returned real counts for every sweep step (`automation-sweep`, `renewals-sweep`, `community-buy-sweep`, etc.) — this is not a guess from reading config, it's observed behavior.

A second mechanism exists but is **not relied upon**: `.github/workflows/automation-scheduler.yml`, a GitHub Actions cron hitting the same endpoint every 10 minutes for a subset of detectors — but it needs a manually-added `CRON_SECRET` repo secret to work, and there's no evidence it's configured (if it isn't, every run 401s silently).

## The real constraint

**A once-daily cron cannot deliver a 4-hour-after-inactivity first touch.** By the time the next daily run happens, more than 4 hours has almost always already passed. I am not describing the current deployment as meeting the spec's cadence — it does not, today.

## What was built to be scheduler-independent

The P2 cadence logic (`scheduleP2Touches`/`duePTouchNumbers` in `automation.detectors.ts`) does not assume any particular cron frequency:

- Every run attempts **every threshold whose time has already passed**, not just the nearest one.
- Each threshold has its own DB-unique dedupe key, so an already-sent touch is a harmless no-op on re-attempt.
- This means: run it every 5 minutes, and the cadence matches the spec exactly (4h/24h/72h, real-time). Run it once a day, and it degrades to "each threshold fires on the first daily check after crossing it" — still correct, still bounded to 3 sends, never skipped, never duplicated, just coarser.

This was verified by test for both patterns: a test asserting touch1 alone fires at exactly 4h, and a test asserting touch1+touch2 both fire in the same run when the gap between checks is large enough to cross two thresholds at once (simulating a daily-or-slower cron).

## What's needed to actually hit 4h/24h/72h

A cron that runs more often than once a day. On Vercel, that requires a plan tier that allows sub-daily cron schedules (the Hobby plan is limited to once/day; Pro and above allow more frequent schedules) — I did not verify which plan this project is on, and did not change the plan or the cron schedule myself (that's an account/billing decision, not a code change I should make unilaterally). **This is the one concrete, actionable blocker for true spec-compliant timing** — not a code gap.

## Repeated-execution safety (tested)

- Same run, same thresholds already fired → no new rows, no new sends (DB-unique dedupe key).
- A gap large enough to span 2+ untouched thresholds → all due thresholds fire in that one run, each with its own key — nothing is silently skipped because the cron was slow once.
- Past the last threshold (72h) → exactly 3 total touches ever exist for that episode, confirmed by test, never a 4th.

## R30 trial-ending reminder

The Stripe `customer.subscription.trial_will_end` webhook arrives three days before trial end, so it cannot drive the required seven-day reminder. R30 now derives a durable `AutomationRun.scheduledFor` at exactly `VendorSubscription.trialEndsAt - 7 days`; the automation sweep stores future runs without sending and dispatches only scheduled runs at/after that timestamp. The dedupe identity includes the exact current trial end. At send time the worker rechecks that the same active, non-cancelled paid trial and owner still exist, the persisted trial end has not changed, and the scheduled time is exactly seven days before that end. Dispatch has a five-minute worker-jitter tolerance; beyond it, a missed window is suppressed rather than sent late. `R30_TRIAL_ENDING_ENABLED` remains off: the verified Vercel cron is daily and cannot establish precise due-time delivery. Sub-daily scheduler verification and runtime QA are required before activation.
