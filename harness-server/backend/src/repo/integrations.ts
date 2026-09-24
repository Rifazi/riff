import { promises as fs } from 'node:fs';
import path from 'node:path';
import { docsDirFor, type AppConfig } from '../apps/apps.js';

export interface IntegrationDoc {
  file: string; // repo-relative path, e.g. docs/transmission/tungsten/invoices.md
  title: string;
}

export interface Integration {
  slug: string; // the folder name, e.g. "tungsten"
  title: string;
  summary: string;
  readmePath: string; // repo-relative path to the folder's README.md
  docs: IntegrationDoc[]; // every other *.md file in the folder
}

function extractTitleAndSummary(markdown: string, fallbackTitle: string): { title: string; summary: string } {
  const lines = markdown.split('\n');
  let title = fallbackTitle;
  let titleLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = /^#\s+(.*)$/.exec(lines[i]);
    if (match) {
      title = match[1].trim();
      titleLineIndex = i;
      break;
    }
  }

  const summaryLines: string[] = [];
  for (let i = titleLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) break; // stop at the next heading
    if (line.trim().length === 0) {
      if (summaryLines.length > 0) break; // blank line ends the first paragraph
      continue;
    }
    summaryLines.push(line.trim());
  }

  return { title, summary: summaryLines.join(' ') };
}

function extractTitle(markdown: string, fallbackTitle: string): string {
  return extractTitleAndSummary(markdown, fallbackTitle).title;
}

/**
 * Reads the completed/existing partner integrations straight off
 * docs/transmission/<vendor>/ folder names in the target repo — the same
 * folders the coding agent creates for a brand-new vendor (see
 * coding-agent.md's "Document it" step). New vendors show up here
 * automatically the moment their folder + README exist; nothing to update
 * by hand.
 */
export async function listIntegrations(app: AppConfig): Promise<Integration[]> {
  const transmissionDir = path.join(docsDirFor(app), 'transmission');
  let entries;
  try {
    entries = await fs.readdir(transmissionDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const vendorDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  const integrations: Integration[] = [];
  for (const slug of vendorDirs) {
    const vendorDir = path.join(transmissionDir, slug);
    const readmeAbs = path.join(vendorDir, 'README.md');
    let readmeContent: string;
    try {
      readmeContent = await fs.readFile(readmeAbs, 'utf8');
    } catch {
      continue; // no README — not a documented integration yet
    }

    const { title, summary } = extractTitleAndSummary(readmeContent, slug);
    const readmePath = path.relative(app.repoRoot, readmeAbs);

    const files = (await fs.readdir(vendorDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
      .map((e) => e.name)
      .sort();

    const docs: IntegrationDoc[] = [];
    for (const fileName of files) {
      const abs = path.join(vendorDir, fileName);
      const content = await fs.readFile(abs, 'utf8');
      docs.push({
        file: path.relative(app.repoRoot, abs),
        title: extractTitle(content, fileName),
      });
    }

    integrations.push({ slug, title, summary, readmePath, docs });
  }

  return integrations;
}
