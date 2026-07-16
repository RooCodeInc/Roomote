---
'@roomote/web': patch
---

Harden the Discord gateway: quarantined (undeliverable) events now surface in
the Discord settings diagnostics instead of accumulating invisibly, the
durable inbound and dead-letter streams are bounded with capacity pressure
reported before shedding, a single transient Redis blip no longer drops a
healthy Gateway connection or ratchets delivery restarts to the maximum
backoff forever, and a dead gateway supervisor reports to error tracking
instead of only logging.
