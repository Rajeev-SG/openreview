import type {
  FrontierFinding,
  ResolutionEntry,
  ResolutionReport,
} from "@/lib/frontier/types";

/**
 * Free, deterministic resolution of a blocked cycle.
 *
 * A cycle buys at most two paid reviews, so once review #2 BLOCKs the PR cannot
 * buy another opinion. The alternative to leaving a required check red forever
 * is to verify the *repair* deterministically: the flagged file must have
 * changed, the change must reach the flagged line when the finding names one,
 * the file must not simply have been deleted, and required CI must be green.
 * Nothing here calls a model.
 *
 * This proves the flagged file changed and CI passed. It does not prove the
 * repair is semantically right - that was review #2's job. Everything the gate
 * cannot verify this way stays unresolved and keeps the PR blocked.
 */

export interface DiffHunk {
  /** First new-file line of the hunk. */
  end: number;
  start: number;
}

export interface FileChange {
  deleted: boolean;
  hunks: DiffHunk[];
  path: string;
}

const POST_IMAGE_PATTERN = /^\+\+\+ (.+)$/;
const PRE_IMAGE_PATTERN = /^--- (.+)$/;
const HUNK_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

const cleanDiffPath = (raw: string): string => {
  // Git quotes paths containing special characters and appends a
  // tab-separated timestamp for non-git diffs.
  let value = raw.split("\t")[0].trim();

  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }

  return value;
};

const stripRoot = (value: string): string | null => {
  const prefix = value.slice(0, 2);

  if (prefix !== "a/" && prefix !== "b/") {
    return null;
  }

  return value.slice(2);
};

/**
 * Parse a unified diff into per-file post-image paths and hunk ranges.
 *
 * Hunk ranges are new-file line numbers, which is what a finding's `line`
 * refers to.
 */
export const parseFileChanges = (diff: string): FileChange[] => {
  const changes: FileChange[] = [];
  let current: FileChange | null = null;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      if (current) {
        changes.push(current);
      }

      current = { deleted: false, hunks: [], path: "" };
      continue;
    }

    const hunk = HUNK_PATTERN.exec(raw);

    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      current.hunks.push({ end: start + Math.max(count - 1, 0), start });
      continue;
    }

    const pre = PRE_IMAGE_PATTERN.exec(raw);

    if (pre && current) {
      const previous = cleanDiffPath(pre[1]);

      // A `--- /dev/null` pre-image means the file is being added; remember the
      // path in case the post-image is also /dev/null (a rename to nothing).
      if (previous !== "/dev/null") {
        const path = stripRoot(previous);

        if (path) {
          current.path = path;
        }
      }

      continue;
    }

    const post = POST_IMAGE_PATTERN.exec(raw);

    if (!post) {
      continue;
    }

    // A bare `+++` line without a `diff --git` header still describes a change
    // (git emits these for some diffs), so start a file for it.
    if (!current) {
      current = { deleted: false, hunks: [], path: "" };
    }

    const next = cleanDiffPath(post[1]);

    if (next === "/dev/null") {
      // Deleting the flagged file is not a repair; treat it as unresolved.
      current.deleted = true;
      continue;
    }

    const path = stripRoot(next);

    if (path) {
      current.path = path;
    }
  }

  if (current) {
    changes.push(current);
  }

  return changes.filter((change) => change.path !== "");
};

/** Extract the post-image paths from a unified diff. */
export const parseChangedPaths = (diff: string): string[] =>
  parseFileChanges(diff)
    .filter((change) => !change.deleted)
    .map((change) => change.path);

export interface PathMatch {
  change: FileChange;
  mode: "basename" | "exact" | "normalised";
}

/**
 * Match a finding's `path` against the diff. The path comes from model output,
 * so tolerate a leading `./` and a wrong directory prefix when the basename is
 * unambiguous; the match mode is reported so the operator can audit it.
 */
export const matchPath = (
  raw: string,
  changes: FileChange[]
): PathMatch | null => {
  const path = raw.trim();

  const exact = changes.find((change) => change.path === path);

  if (exact) {
    return { change: exact, mode: "exact" };
  }

  const normalised = path.replace(/^\.\//, "");
  const normalisedMatch = changes.find(
    (change) => change.path.replace(/^\.\//, "") === normalised
  );

  if (normalisedMatch) {
    return { change: normalisedMatch, mode: "normalised" };
  }

  const basename = normalised.split("/").pop();
  const basenameMatches = basename
    ? changes.filter((change) => change.path.split("/").pop() === basename)
    : [];

  if (basenameMatches.length === 1) {
    return { change: basenameMatches[0], mode: "basename" };
  }

  return null;
};

const describe = (match: PathMatch): string =>
  match.mode === "exact"
    ? `\`${match.change.path}\``
    : `\`${match.change.path}\` (${match.mode} match)`;

/**
 * A finding is addressed when its file changed and, if the finding names a
 * line, the change actually reaches that line. A deletion of the flagged file
 * is never a repair.
 */
export const buildResolutionReport = (input: {
  changes: FileChange[];
  findings: FrontierFinding[];
  requiredCiGreen: boolean;
}): ResolutionReport => {
  const entries: ResolutionEntry[] = input.findings.map((finding) => {
    const base = {
      id: finding.id,
      path: finding.path,
      severity: finding.severity,
    };
    const unresolved = (evidence: string): ResolutionEntry => ({
      ...base,
      evidence,
      status: "unresolved",
    });

    if (!finding.path) {
      return unresolved("no file path; not deterministically verifiable");
    }

    const match = matchPath(finding.path, input.changes);

    if (!match) {
      return unresolved(
        `\`${finding.path}\` is not in the repair diff since the blocked review`
      );
    }

    if (match.change.deleted) {
      return unresolved(
        `${describe(match)} was deleted, which is not a repair`
      );
    }

    const { line } = finding;

    if (line !== undefined) {
      const reached = match.change.hunks.some(
        (hunk) => line >= hunk.start && line <= hunk.end
      );

      if (!reached) {
        return unresolved(
          `${describe(match)} changed, but not at line ${line}`
        );
      }
    }

    if (!input.requiredCiGreen) {
      return unresolved(
        `${describe(match)} changed, but required CI is not green`
      );
    }

    const where =
      line === undefined ? describe(match) : `${describe(match)} line ${line}`;

    return {
      ...base,
      evidence: `${where} changed and required CI is green`,
      status: "addressed",
    };
  });

  const unresolvedEntries = entries.filter(
    (entry) => entry.status === "unresolved"
  );

  return {
    entries,
    // No blocking findings is not a resolution: a blocked cycle always has
    // some, and an empty list means the state is inconsistent.
    resolved: entries.length > 0 && unresolvedEntries.length === 0,
    unresolved: unresolvedEntries,
  };
};

export const renderResolutionMarkdown = (report: ResolutionReport): string =>
  [
    "| Finding | Severity | File | Status | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...report.entries.map(
      (entry) =>
        `| ${entry.id} | ${entry.severity} | ${
          entry.path ? `\`${entry.path}\`` : "-"
        } | ${entry.status === "addressed" ? "addressed" : "**unresolved**"} | ${
          entry.evidence
        } |`
    ),
  ].join("\n");
