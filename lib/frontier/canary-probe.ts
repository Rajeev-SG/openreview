/**
 * Canary probe (temporary): a small, genuinely reviewable runtime change used
 * to exercise the deployed gate end to end. Removed before merge.
 */
export const canaryNormalizeRepo = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

export const canaryIsGatedRepo = (
  repo: string,
  gated: readonly string[]
): boolean => gated.includes(canaryNormalizeRepo(repo));
