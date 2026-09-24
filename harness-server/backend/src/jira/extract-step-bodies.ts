// Pulls each step's own section out of the plan doc's markdown body, so a
// Jira ticket can carry that step's full implementation detail instead of
// just its title. Relies on prompts/plan-agent.md's fixed step heading
// format ("### <n>. <title>") — steps are matched by position (the Nth
// "### " heading under "## Steps" maps to steps[N]), not by parsing the
// title text back out, since the agent's title wording doesn't have to
// match verbatim.
export function extractStepBodies(markdownBody: string, stepCount: number): string[] {
  const lines = markdownBody.replace(/\r\n/g, '\n').split('\n');
  const bodies: string[] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (current) bodies.push(current.join('\n').trim());
      current = [];
      continue;
    }
    if (/^##\s+/.test(line) && current) {
      // A new "## " section (e.g. the doc ends and something else follows,
      // which shouldn't normally happen since Steps is last, but guards
      // against a step accidentally swallowing trailing content).
      bodies.push(current.join('\n').trim());
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) bodies.push(current.join('\n').trim());

  // Pad or truncate to stepCount so callers can always zip 1:1 with the
  // structured steps list, even if the agent's markdown drifted.
  while (bodies.length < stepCount) bodies.push('');
  return bodies.slice(0, stepCount);
}
