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

const STATUS_LABEL: Record<ResolutionEntry["status"], string> = {
  addressed: "addressed",
  not_verifiable: "**not deterministically verifiable**",
  unresolved: "**unresolved**",
};

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
  /**
   * New-file line counts at the repaired head, keyed by path. A finding whose
   * line is past the end of the file cannot be reached by any hunk, so the
   * line requirement is unsatisfiable by construction — see below.
   */
  fileLineCounts?: Record<string, number>;
  /**
   * Finding paths that are not repository files (verified by the caller
   * against the head ref). No diff can ever match them, so enforcing the
   * file-change requirement would block the cycle forever — the same defect
   * class as a non-positive line. They are reported as not deterministically
   * verifiable rather than left permanently blocking.
   */
  nonFileFindingPaths?: ReadonlySet<string>;
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

    // A path that is neither in the repair diff nor a repository file (the
    // caller verified it against the head ref) can never be satisfied by any
    // push - model output like "PR description / CI gate". Holding the cycle
    // blocked on it forever is the same defect class as a non-positive line.
    // It is surfaced as not deterministically verifiable and needs an owner
    // decision instead.
    if (!match && input.nonFileFindingPaths?.has(finding.path)) {
      return {
        ...base,
        evidence:
          `\`${finding.path}\` is not a repository file, so no repair diff can ` +
          "ever satisfy it — dispose of it by hand or start a new cycle with " +
          "`frontier-new-cycle`",
        status: "not_verifiable",
      };
    }

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
    const lineCount = input.fileLineCounts?.[match.change.path];

    // A line past the end of the file is the same class of defect as a
    // non-positive line: no hunk can ever reach it, so enforcing it would leave
    // the finding permanently unresolvable and block the cycle forever. The
    // repair is verified by the file change plus green CI, and the evidence says
    // so explicitly rather than implying the line was matched.
    const lineBeyondFile =
      line !== undefined &&
      line > 0 &&
      lineCount !== undefined &&
      line > lineCount;

    // Only a real, positive line inside the file is a location the repair must
    // reach. A non-positive line means "no specific line".
    if (line !== undefined && line > 0 && !lineBeyondFile) {
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
      evidence: lineBeyondFile
        ? `${describe(match)} changed; the reported line ${line} is past the file's ` +
          `${lineCount} lines, so it was verified by file change and green CI`
        : `${where} changed and required CI is green`,
      status: "addressed",
    };
  });

  const unresolvedEntries = entries.filter(
    (entry) => entry.status === "unresolved"
  );
  const notVerifiable = entries.filter(
    (entry) => entry.status === "not_verifiable"
  );

  return {
    entries,
    notVerifiable,
    // No blocking findings is not a resolution: a blocked cycle always has
    // some, and an empty list means the state is inconsistent. A finding
    // whose path is not a repository file also keeps the cycle from a
    // deterministic pass: it is surfaced as not_verifiable and needs an
    // explicit owner decision (`frontier-ack-not-verifiable`) instead.
    resolved:
      entries.length > 0 &&
      unresolvedEntries.length === 0 &&
      notVerifiable.length === 0,
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
        } | ${STATUS_LABEL[entry.status]} | ${entry.evidence} |`
    ),
  ].join("\n");
