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
 * GitHub returns this when the repository's plan does not include branch
 * protection at all - a private repository on the Free plan. Observed with an
 * account-admin token, so it is a plan limit rather than a permission gap: the
 * App's `administration` permission cannot change it.
 */
const PROTECTION_NOT_OFFERED =
  /upgrade to github pro|make this repository public/i;

/**
 * Classify a failed read of a branch's required checks.
 *
 * - `none`       the branch has no protection: there is genuinely nothing to wait for
 * - `unreadable` the App is not permitted to read it (403): the answer is unknown
 * - `throw`      anything else is a real error and must surface
 *
 * A 403 whose message says the plan does not offer branch protection is `none`,
 * not `unreadable`. No required-check list can exist for that repository, so
 * there is nothing to wait for - the same conclusion as a 404. Reporting it as
 * unknown instead made every private Free-plan repository fail closed and skip
 * review forever, while granting more permission could never fix it.
 */
export const classifyRequiredChecksFailure = (
  status?: number | undefined,
  message?: string | undefined
): "none" | "unreadable" | "throw" => {
  if (status === 404) {
    return "none";
  }
  if (status === 403) {
    return PROTECTION_NOT_OFFERED.test(message ?? "") ? "none" : "unreadable";
  }
  return "throw";
};
