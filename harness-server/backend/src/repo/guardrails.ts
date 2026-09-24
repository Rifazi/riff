import path from 'node:path';

export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathNotAllowedError';
  }
}

/**
 * Every file-touching tool across every agent role routes through this
 * function instead of duplicating allowlist logic. The tool set granted to
 * each role (see agents/*-agent.ts) is the real security boundary; this is
 * the second layer, shared so the three near-identical tool files can't drift.
 */
export function assertPathAllowed(requestedPath: string, allowedRoots: string[], repoRoot: string): string {
  const absolute = path.resolve(repoRoot, requestedPath);
  const relativeToRepo = path.relative(repoRoot, absolute);

  if (relativeToRepo.startsWith('..') || path.isAbsolute(relativeToRepo)) {
    throw new PathNotAllowedError(`${requestedPath} resolves outside the repo (${repoRoot}).`);
  }

  // "harness" here is the target repo's committed-artifacts folder
  // (harness/requirements/, harness/qa-reports/) — written only by the
  // dedicated write_requirements_doc/write_qa_report tools, which call fs
  // directly and never go through this function. General-purpose file tools
  // (read_file/write_file/edit_file/search_code) have no business there.
  const forbidden = ['.env', '.git', 'node_modules', 'cdk.out', '.ts-path-config.json', 'harness'];
  const firstSegment = relativeToRepo.split(path.sep)[0];
  if (forbidden.includes(firstSegment)) {
    throw new PathNotAllowedError(`${requestedPath} is in a forbidden path (${firstSegment}/).`);
  }

  const isAllowed = allowedRoots.some((root) => {
    if (root === '.') return true; // explicit "anything under the repo root (minus forbidden paths above)"
    const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
    return relativeToRepo === normalizedRoot || relativeToRepo.startsWith(`${normalizedRoot}${path.sep}`);
  });

  if (!isAllowed) {
    throw new PathNotAllowedError(
      `${requestedPath} is outside this tool's allowed paths (${allowedRoots.join(', ')}).`
    );
  }

  return absolute;
}
