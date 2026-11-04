// Automatic reports join active work at the next safe boundary, without aborting its current tool.
// Idle conversations still start a run. Stable request IDs at each source prevent duplicate admissions.
export const REPORT_WHEN_BUSY = "steer" as const;
