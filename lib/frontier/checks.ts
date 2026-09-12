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
