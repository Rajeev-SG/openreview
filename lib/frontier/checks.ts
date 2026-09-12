import { FRONTIER_CHECK_NAME } from "@/lib/frontier/types";

/**
 * Drop the gate's own check from a list of required checks.
 *
 * `frontier-quality` is normally itself a required branch check, and the gate
 * reads required checks to decide whether it may spend. Left in, the gate would
 * wait for the very check it is about to create — a permanent deadlock where no
 * review ever runs and every PR sits "Expected — waiting for status".
 *
 * It is never a precondition for its own review, so it is always excluded.
 */
export const withoutSelfCheck = (
  names: (string | undefined | null)[]
): string[] =>
  [...new Set(names)].filter(
    (name): name is string => Boolean(name) && name !== FRONTIER_CHECK_NAME
  );

/**
 * Classify a failed read of a branch's required checks.
 *
 * - `none`       the branch has no protection: there is genuinely nothing to wait for
 * - `unreadable` the App is not permitted to read it (403): the answer is unknown
 * - `throw`      anything else is a real error and must surface
 */
export const classifyRequiredChecksFailure = (
  status?: number | undefined
): "none" | "unreadable" | "throw" => {
  if (status === 404) {
    return "none";
  }
  if (status === 403) {
    return "unreadable";
  }
  return "throw";
};
