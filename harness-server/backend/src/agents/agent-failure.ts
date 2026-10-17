// What Bridget does when an agent turn fails or says it is stuck. Pure, so it
// is tested without a model (frontend/tests/harness-server/agent-failure.test.ts).

const USAGE_LIMIT =
  /usage limit|limit reached|hit your (usage |rate )?limit|reached your (usage )?limit|out of (tokens|credits)|credit balance|insufficient[_ ](credit|quota|funds)|quota[_ ](exceeded|exhausted)|exceeded your (current )?(quota|limit)|billing|rate[_ ]?limit|too many requests|\b429\b|resource[_ ]exhausted|overloaded/i;

/** Whether an agent's error text means the model's tokens, quota or rate limit ran out, so another attempt fails the same way. */
export function isUsageLimitError(text: string | null | undefined): boolean {
  return Boolean(text) && USAGE_LIMIT.test(text!);
}

export function usageLimitStopReason(detail: string): string {
  const excerpt = detail.replace(/\s+/g, ' ').trim().slice(0, 240);
  return `The model's usage limit has been reached (${excerpt}). Retrying now would fail the same way, so I've stopped. Turn auto-drive back on or send a message once it resets.`;
}

// A stuck agent whose problem it can fix itself: something it couldn't find or
// set up. These are never a reason to bring in a human.
const TECHNICAL_BLOCK =
  /(cannot|can'?t|could not|couldn'?t|unable to|failed to|did not|didn'?t|no)\b[^.\n]{0,60}\b(find|locate|located|found|match(es)?|exist|resolve|import|install|run|set ?up|configure|config)|not found|no such file|no matches|missing (test|setup|config|file|dependency|dependencies|module|package)|test (setup|file|framework|runner)/i;

// What only a person can supply or decide.
const HUMAN_ONLY =
  /credential|api[ _-]?key|password|secret|login|log in|sign in|authenticat|authoriz|permission|access to|approv|confirm|which (one|option)|choose|decide|your (call|decision|preference)|product|requirement is (unclear|ambiguous)|clarif/i;

/** A "blocked" reason that is really the agent not finding or setting up something: it should try another way, not stop. */
export function isSelfHealableBlock(reason: string, lastAgentText: string): boolean {
  const text = `${reason}\n${lastAgentText.slice(-1500)}`;
  return TECHNICAL_BLOCK.test(text) && !HUMAN_ONLY.test(text);
}

export const SELF_HEAL_MESSAGE =
  "Don't stop for this: it's yours to solve. Search by other names and paths (the file may live elsewhere or be named differently), check package.json and the config for how tests and tooling are set up, and if what you need doesn't exist yet, create it following a neighbouring example. Only come back with a question if it needs a credential or a decision only the human can make.";

/** Self-heal nudges allowed in a row before Bridget stops for the human. */
export const MAX_SELF_HEALS = 2;
/** Turns in a row that end in an error before Bridget stops for the human. */
export const MAX_FAILED_TURNS = 2;
