# Replay reconnect budget repair — 2026-10-01

A recorded (replay) session died after 16 minutes with `unavailable/reconnect_exhausted`
while chat was still arriving (production session `lc_01139bae…`, 13:11–13:27 KST,
collector revision `ec203bd9`). The collector diag showed the shape:

```
13:25:38 schedule_reconnect provider_poll_failed attempt=0
13:25:48 schedule_reconnect get_info_failed      attempt=1
13:25:56 schedule_reconnect get_info_failed      attempt=2
13:26:01 got_info + replay_first_page items=49   (attempt stays 3)
13:26:09 schedule_reconnect provider_poll_failed attempt=3
13:26:18 replay_first_page items=50              (attempt stays 4)
13:26:25 schedule_reconnect provider_poll_failed attempt=4
13:26:51 schedule_reconnect provider_poll_failed attempt=5 → fail_permanently reconnect_exhausted
```

## Cause

`reconnectAttempt` is reset only by the fetch observer while `collecting()` is true.
For recorded playback `collecting()` means `replayScheduler.started`, which turns true
*after* the first page's successful response has already been observed. A reconnect
that re-establishes the replay therefore never counted as recovery; only a later page
could reset the budget. "Reconnect OK → next page fails" cycles exhausted the five
retries (1, 2, 4, 8, 16 s) in about 40 s. Live playback is unaffected: `activeLiveChat`
is set before its first poll succeeds.

Nothing recorded whether YouTube refused the failed requests (403/429) or they timed
out; the collector proxy answers are not logged.

## Change

- `useLiveChat.ts`: after `scheduler.start()` on a first page whose chat reaches past
  the resume point (`fetchedHorizonMs > startOffsetMs`), `reconnectAttempt = 0`. An
  empty first page is not progress and keeps the budget. `replay_first_page` diag now
  carries `attempt` and `budgetReset`.
- `innertubeFetch.ts`: failed liveness requests report `{ path, status | null,
  durationMs, error? }` to `onRequestFailed`; failed bootstrap calls (`player`, `next`)
  go to a new `onBootstrapRequestFailed`. The tight `updated_metadata` 404 loop reports
  nothing. `useLiveChat.ts` writes both as `provider_request_failed` /
  `bootstrap_request_failed` diag lines (error class name only, never the message).
- Proxy endpoints, credentials, headers, bridge contracts, and app configuration are
  unchanged. No new mobile binary is required.

## Validation

- 98 collector tests pass (94 before + 4 new), lint and TypeScript checks pass.
- `recorded reconnects that re-establish the replay do not exhaust the retry budget`
  fails against the previous revision (`unavailable/reconnect_exhausted` after 6
  lookups) and passes with the change (reconnects keep going for 120 s of alternating
  page failures, chat keeps flowing).
- `recorded pages that keep failing without any first page still exhaust the retry
  budget` keeps the bounded exhaustion (6 lookups) when no page ever succeeds.
- Fetch diagnostics: HTTP 503 and a thrown `TypeError` carry status/duration/error
  class; a `player` 429 reports as bootstrap only; `updated_metadata` 404 reports nothing.

Deploy this revision to the existing `flyer-live-chat-collector-dev` service with the
same build args as before (debug bridge off, source URL and revision pinned to the
deployed commit). Verify health, the source pin in the page footer, and a short replay
session's `replay_first_page` / `provider_request_failed` diag lines afterwards.
