---
'@roomote/web': patch
---

The addressee gate for unmentioned thread replies is less conservative and easier to read. A reply routes when Roomote is the likeliest addressee by a majority of the probability instead of a fixed high bar, so the decision holds up across judgment backends with different calibration; only bare closing acknowledgements such as "ok thanks" are dropped, so remarks and jokes aimed at Roomote get a reply; the model is told who spoke last; and every decision logs its scores, without message text, for tuning.
