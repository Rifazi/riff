import matter from 'gray-matter';
import { stepFiles } from './team/split-hint.js';

const isDocFile = (file: string) => /\.mdx?$/i.test(file) || /(^|\/)docs\//.test(file);

/**
 * Plan steps whose own section names only documentation files are light
 * whatever the classifier says about their title: the title-only classifier
 * tagged "Docs: docs/edi-viewer.md" standard, so the last step of a plan
 * ran on the full coding model.
 */
export function docsOnlyStepIds(planRaw: string): Set<string> {
  const ids = new Set<string>();
  for (const step of stepFiles(planRaw)) {
    if (step.files.length > 0 && step.files.every(isDocFile)) ids.add(step.id);
  }
  return ids;
}

/** The steps the plan frontmatter lists, as the plan body `write_plan_doc` is about to write. */
export function docsOnlyStepIdsOf(markdownBody: string, steps: { id: string; title: string }[]): Set<string> {
  return docsOnlyStepIds(matter.stringify(`\n${markdownBody.trim()}\n`, { steps }));
}
