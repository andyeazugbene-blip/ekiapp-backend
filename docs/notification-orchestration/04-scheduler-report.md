# Scheduler Report

## Actual deployment configuration

`vercel.json`:
```json
"crons": [{ "path": "/api/internal/jobs/daily-sweep", "schedule": "0 12 * * *" }]
```

One cron, once per day, 12:00 UTC. Confirmed via a live manual trigger of this exact endpoint on 2026-10-25 (production), which returned real counts for every sweep step (`automation-sweep`, `renewals-sweep`, `community-buy-sweep`, etc.) — this is not a guess from reading config, it's observed behavior.

A second mechanism exists: `.github/workflows/automation-scheduler.yml` declares a GitHub Actions cron every 10 minutes for a subset of detectors. It is not operating as configured. Recent run history shows large gaps (latest recorded scheduled run `40468800224` at 2026-10-27 07:43 UTC, after the previous run at 02:06 UTC), not a ten-minute cadence. The latest run log sent an empty `Authorization: Bearer ` value and all five internal endpoints returned HTTP 401. The repository secret name `CRON_SECRET` is listed, but its value cannot be inspected; its availability/value is an account-level action for the repository owner to verify against the Vercel project value. The old workflow used `continue-on-error: true`, causing the overall run to appear successful despite these failures. Follow-up code removes that masking, checks the secret without printing it, and fails clearly on an unavailable secret or failed endpoint. No secret value was read or changed.

PR #45 has since merged at backend main commit `746a394` (2026-10-27 13:03 UTC); its CI and Vercel checks passed. A subsequent code review found that the original `curl` steps could still mask a transport failure: after curl exited nonzero, Bash could continue with an empty status and complete the `if` block successfully. They also printed unfiltered response bodies. The follow-up PR #46 replaces those calls with `scripts/call-internal-scheduler-endpoint.mjs`: missing credentials, transport failures/timeouts, redirects, and non-2xx statuses fail the step; logs include only the static endpoint name and status class/code, never the authorization header, response body, or caught error details. Six focused tests and GitHub CI run `40510998294` passed; Vercel preview and preview comments also passed. This code-side fix does not verify that GitHub injects the owner's secret or that scheduled runs occur on time.

Verified record: [GitHub Actions run 40468800224](https://github.com/andyeazugbene-blip/ekiapp-backend/actions/runs/40468800224), fetched on 2026-10-27. A listed secret name alone does not prove GitHub injected a usable value into a run.

## The real constraint

The individual O-02/R13 and O-04/R15 endpoints are retained for scheduler compatibility. PR #47 changes their service methods to return `skipped: true` until the business-hours acceptance SLA and actual dispatch deadline are approved and represented in domain state. After that change is merged, a successful HTTP response for either job will mean the fail-closed skip was recorded, not that a reminder was sent. See the corresponding rows in `01-compliance-matrix.md`.

PR #46 has since merged into backend main at `8243cb5` and hardens the unrelated scheduler HTTP transport. PR #47 remains open; its service change is on the rebased branch, so the behavior described above is proposed and is not yet part of `main`.

**A once-daily cron cannot deliver a 4-hour-after-inactivity first touch.** By the time the next daily run happens, more than 4 hours has almost always already passed. I am not describing the current deployment as meeting the spec's cadence — it does not, today.

## What was built to be scheduler-independent

The P2 cadence logic (`scheduleP2Touches`/`duePTouchNumbers` in `automation.detectors.ts`) does not assume any particular cron frequency:

- Every run attempts **every threshold whose time has already passed**, not just the nearest one.
- Each threshold has its own DB-unique dedupe key, so an already-sent touch is a harmless no-op on re-attempt.
- This means: run it every 5 minutes, and the cadence matches the spec exactly (4h/24h/72h, real-time). Run it once a day, and it degrades to "each threshold fires on the first daily check after crossing it" — still correct, still bounded to 3 sends, never skipped, never duplicated, just coarser.

This was verified by test for both patterns: a test asserting touch1 alone fires at exactly 4h, and a test asserting touch1+touch2 both fire in the same run when the gap between checks is large enough to cross two thresholds at once (simulating a daily-or-slower cron).

## What's needed to actually hit 4h/24h/72h

A functioning sub-daily scheduler with verified successful execution, plus delivery processing within its promised interval. The repository already declares a ten-minute Actions workflow, but real execution history and its 401 responses do not establish that it operates. The repository owner must verify the existing `CRON_SECRET` Actions secret contains the same value as the Vercel environment secret and that scheduled workflow execution is enabled; do not disclose the value in chat/logs. If GitHub schedule delays remain multi-hour, choose an execution platform/cadence with an acceptable timing SLA (any Vercel plan change is a billing decision). No account, billing, workflow secret, or production setting was changed. **R30 and all cadence-sensitive rules stay gated until observed successful sub-daily execution and end-to-end timing QA.**

## Repeated-execution safety (tested)

- Same run, same thresholds already fired → no new rows, no new sends (DB-unique dedupe key).
- A gap large enough to span 2+ untouched thresholds → all due thresholds fire in that one run, each with its own key — nothing is silently skipped because the cron was slow once.
- Past the last threshold (72h) → exactly 3 total touches ever exist for that episode, confirmed by test, never a 4th.

## R30 trial-ending reminder

The Stripe `customer.subscription.trial_will_end` webhook arrives three days before trial end, so it cannot drive the required seven-day reminder. R30 derives a durable `AutomationRun.scheduledFor` at exactly `VendorSubscription.trialEndsAt - 7 days`; the automation sweep stores future runs without sending and dispatches only scheduled runs at/after that timestamp. The dedupe identity includes the exact current trial end. At send time the worker rechecks that the same active, non-cancelled paid trial and owner still exist, the persisted trial end has not changed, and the scheduled time is exactly seven days before that end. Dispatch has a five-minute worker-jitter tolerance; beyond it, a missed window is suppressed rather than sent late. `R30_TRIAL_ENDING_ENABLED` remains off: Vercel is daily and the ten-minute Actions path has recent multi-hour gaps and 401s. Sub-daily scheduler verification and runtime QA are required before activation.
