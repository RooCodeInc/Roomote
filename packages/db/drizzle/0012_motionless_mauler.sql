-- The v0.6 application no longer uses these settings, but v0.5 still selects
-- them during the expand/rollback compatibility window. Keep the physical
-- columns until v0.6 is the supported N-1 rollback target.
SELECT 1;
