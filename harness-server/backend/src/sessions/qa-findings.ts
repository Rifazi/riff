import matter from 'gray-matter';

/**
 * The part of a QA report that needs acting on: result, failing checks and
 * the blocking findings. Used for the send-back relay to the coding agent
 * and to brief a fresh QA pass on what it flagged last time.
 */
export function compactQaFindings(raw: string): string {
  const parsed = matter(raw);
  const d = parsed.data as Record<string, unknown>;
  const failedChecks = (
    [
      ['lint', d.lint],
      ['unit tests', d['unit-tests']],
      ['integration tests', d['integration-tests']],
    ] as const
  )
    .filter(([, v]) => v === 'fail')
    .map(([name]) => name);

  // Reports written before blocking-findings existed: fall back to the
  // unchecked criteria and [blocking] lines the prompt's template produces.
  const listed = Array.isArray(d['blocking-findings']) ? (d['blocking-findings'] as unknown[]).map(String) : null;
  const findings =
    listed ??
    parsed.content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^- \[ \]/.test(l) || /^- \[blocking\]/i.test(l))
      .map((l) => l.replace(/^- \[(?: |blocking)\]\s*/i, ''));

  let text = `QA result: ${d.result ?? '?'}`;
  if (failedChecks.length > 0) text += ` — failing checks: ${failedChecks.join(', ')}`;
  text += findings.length > 0 ? `\n\nFix:\n${findings.map((f) => `- ${f}`).join('\n')}` : '\n\nNo blocking findings were listed.';
  return text;
}
