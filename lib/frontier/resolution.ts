import type {
  FrontierFinding,
  ResolutionEntry,
  ResolutionReport,
} from "@/lib/frontier/types";

/**
 * Free, deterministic resolution of a blocked cycle.
 *
 * A cycle buys at most two paid reviews, so once review #2 BLOCKs the PR cannot
 * buy another opinion. The alternative to leaving the check red forever is to
 * verify the *repair* deterministically: each blocking finding must name a file,
 * that file must have changed since the blocked review, and the repository's
 * required CI must be green. Nothing here calls a model.
 *
 * This proves the flagged file changed and CI passed. It does not prove the
 * repair is semantically correct - that is what review #2 was for. Findings
 * that name no file cannot be verified this way and stay unresolved.
 */

const POST_IMAGE_PATTERN = /^\+\+\+ (.+)$/;

/** Extract the post-image paths from a unified diff. */
export const parseChangedPaths = (diff: string): string[] => {
  const paths = new Set<string>();

  for (const raw of diff.split("\n")) {
    const match = POST_IMAGE_PATTERN.exec(raw);

    if (!match) {
      continue;
    }

    // Git quotes paths containing special characters, and appends a
    // tab-separated timestamp for non-git diffs.
    let value = match[1].split("\t")[0].trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    // Deletions post to /dev/null and carry no path.
    if (value === "/dev/null") {
      continue;
    }

    // Only a/ and b/ prefixed post-images are real paths; anything else is a
    // diff header we do not understand, and guessing would be worse than
    // reporting it as unchanged.
    const prefix = value.slice(0, 2);

    if (prefix !== "a/" && prefix !== "b/") {
      continue;
    }

    const path = value.slice(2);

    if (path !== "") {
      paths.add(path);
    }
  }

  return [...paths];
};

export const buildResolutionReport = (input: {
  changedPaths: string[];
  findings: FrontierFinding[];
  requiredCiGreen: boolean;
}): ResolutionReport => {
  const changed = new Set(input.changedPaths);

  const entries: ResolutionEntry[] = input.findings.map((finding) => {
    const base = {
      id: finding.id,
      path: finding.path,
      severity: finding.severity,
    };

    if (!finding.path) {
      return {
        ...base,
        evidence: "no file path; not deterministically verifiable",
        status: "unresolved" as const,
      };
    }

    if (!changed.has(finding.path)) {
      return {
        ...base,
        evidence: `\`${finding.path}\` unchanged since the blocked review`,
        status: "unresolved" as const,
      };
    }

    if (!input.requiredCiGreen) {
      return {
        ...base,
        evidence: `\`${finding.path}\` changed, but required CI is not green`,
        status: "unresolved" as const,
      };
    }

    return {
      ...base,
      evidence: `\`${finding.path}\` changed and required CI is green`,
      status: "addressed" as const,
    };
  });

  const unresolved = entries.filter((entry) => entry.status === "unresolved");

  return {
    entries,
    // No blocking findings is not a resolution - a blocked cycle always has
    // some, and an empty list means the state is inconsistent.
    resolved: entries.length > 0 && unresolved.length === 0,
    unresolved,
  };
};

export const renderResolutionMarkdown = (report: ResolutionReport): string =>
  [
    "| Finding | Severity | File | Status | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...report.entries.map(
      (entry) =>
        `| ${entry.id} | ${entry.severity} | ${entry.path ? `\`${entry.path}\`` : "-"} | ${
          entry.status === "addressed" ? "addressed" : "**unresolved**"
        } | ${entry.evidence} |`
    ),
  ].join("\n");
