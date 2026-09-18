/**
 * Repository-matching helper used by the diagnostics surface.
 *
 * Kept deliberately small: it normalises a repository name and answers whether
 * a repository is in a configured set. The trailing-slash and whitespace
 * tolerance exists because repository names are copied by hand from the GitHub
 * UI and from PR URLs, where both shapes occur.
 */
export const normalizeRepoName = (value: string): string =>
  value.trim().replaceAll(/\s+/g, " ").toLowerCase();

export const isRepoInSet = (
  repo: string,
  candidates: readonly string[]
): boolean => candidates.includes(normalizeRepoName(repo));
