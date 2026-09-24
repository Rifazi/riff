import { promises as fs } from 'node:fs';
import matter from 'gray-matter';
import { createJiraIssue, getEpicKeyForIssue, JiraError } from './jira-client.js';
import { extractStepBodies } from './extract-step-bodies.js';
import type { JiraSettings } from '../settings/settings.js';

export interface PlanTicketRef {
  stepId: string;
  title: string;
  key: string;
  url: string;
}

export interface PlanTicketError {
  stepId: string;
  title: string;
  message: string;
}

export interface JiraPlanRecord {
  epicKey: string;
  issues: PlanTicketRef[];
}

export interface CreateTicketsResult extends JiraPlanRecord {
  errors: PlanTicketError[];
}

interface PlanStep {
  id: string;
  title: string;
}

// Idempotent: steps that already have a Jira issue recorded in the plan
// doc's frontmatter (from an earlier, possibly partial, run) are skipped —
// re-clicking "Create tickets in Jira" only fills in what's missing rather
// than creating duplicates.
export async function createTicketsFromPlan(
  planFilePath: string,
  sessionKey: string,
  featureTitle: string,
  jiraSettings: JiraSettings
): Promise<CreateTicketsResult> {
  const raw = await fs.readFile(planFilePath, 'utf8');
  const parsed = matter(raw);
  const steps = (parsed.data.steps ?? []) as PlanStep[];
  if (steps.length === 0) {
    throw new JiraError('This plan has no structured steps to turn into tickets.');
  }

  const existing = (parsed.data.jira as JiraPlanRecord | undefined) ?? { epicKey: '', issues: [] };
  const alreadyCreated = new Set(existing.issues.map((issue) => issue.stepId));
  const pending = steps.filter((step) => !alreadyCreated.has(step.id));

  const result: CreateTicketsResult = {
    epicKey: existing.epicKey,
    issues: [...existing.issues],
    errors: [],
  };

  if (pending.length === 0) {
    return result;
  }

  if (!result.epicKey) {
    result.epicKey = await getEpicKeyForIssue(jiraSettings, sessionKey);
  }

  const bodies = extractStepBodies(parsed.content, steps.length);

  for (const step of pending) {
    const index = steps.findIndex((s) => s.id === step.id);
    const stepBody = bodies[index] || '_(no detail written for this step)_';
    const descriptionMarkdown =
      `**Feature:** ${featureTitle} (${sessionKey})\n\n` +
      `${stepBody}\n\n` +
      `---\n_From the approved implementation plan for ${sessionKey}._`;

    try {
      const issue = await createJiraIssue(jiraSettings, {
        summary: step.title,
        descriptionMarkdown,
        epicKey: result.epicKey,
      });
      result.issues.push({ stepId: step.id, title: step.title, key: issue.key, url: issue.url });
    } catch (err) {
      result.errors.push({ stepId: step.id, title: step.title, message: err instanceof Error ? err.message : String(err) });
    }
  }

  const updatedFrontmatter = { ...parsed.data, jira: { epicKey: result.epicKey, issues: result.issues } };
  const fileContents = matter.stringify(`\n${parsed.content.trim()}\n`, updatedFrontmatter);
  await fs.writeFile(planFilePath, fileContents, 'utf8');

  return result;
}
