---
"@roomote/bullmq": patch
---

Make the Brain's nightly synthesis resilient: a digest or weekly synthesis that cites a page outside its evidence now gets one corrective pass naming the violation, then drops the stray citation rather than failing the whole job (which let scheduler retries re-run every search and queue the maintenance cycle three times on a bad night); the weekly synthesis may cite sources that appear inside the digests it was given; the maintenance cycle is submitted at most once per day; and the gbrain container drains its own unfenced hot-memory facts daily so the extract_facts phase, which had been skipped every night as an "interrupted upgrade", runs again.
