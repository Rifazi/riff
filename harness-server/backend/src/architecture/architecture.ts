import path from 'node:path';

// An app can opt into an architecture its agents follow. The only one so
// far is Wayfinding (https://github.com/Rifazi/wayfinding-architecture):
// every important decision is owned by exactly one domain, MAP.md indexes
// the domains, each domain's DOMAIN.md holds its rules, and changes go
// requirement → decision → domain → interface → consumers → segment.
export const WAYFINDING_REPO_URL = 'https://github.com/Rifazi/wayfinding-architecture';

export interface WayfindingConfig {
  kind: 'wayfinding';
  // Repo-relative folder the domains live under (each one a folder with a DOMAIN.md).
  srcDir: string;
  // A domain's one public file, the only one other domains may import. Matched
  // by stem, so "service.ts" also accepts service.js / service.tsx.
  interfaceFile: string;
}

export type ArchitectureConfig = WayfindingConfig;

export const DEFAULT_WAYFINDING: WayfindingConfig = { kind: 'wayfinding', srcDir: 'src', interfaceFile: 'service.ts' };

export const MAP_PATH = 'MAP.md';
export const DOMAIN_DOC = 'DOMAIN.md';
// Riff-generated guide to the procedure; under docs/ so search_docs indexes it.
export const WAYFINDING_GUIDE_PATH = 'docs/wayfinding.md';

export class InvalidArchitectureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArchitectureError';
  }
}

/**
 * Validates what the Apps page sends. null/undefined → no architecture.
 * Paths are kept repo-relative and inside the repo, since the audit walks them.
 */
export function parseArchitectureConfig(input: unknown): ArchitectureConfig | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') throw new InvalidArchitectureError('architecture must be an object or null.');
  const raw = input as Record<string, unknown>;
  if (raw.kind !== 'wayfinding') throw new InvalidArchitectureError(`Unknown architecture "${String(raw.kind)}".`);

  const srcDir = typeof raw.srcDir === 'string' && raw.srcDir.trim() ? raw.srcDir.trim() : DEFAULT_WAYFINDING.srcDir;
  const normalized = path.posix.normalize(srcDir.replace(/\\/g, '/')).replace(/^\.\/|\/+$/g, '') || '.';
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new InvalidArchitectureError(`The source folder "${srcDir}" must be a path inside the repo, like "src".`);
  }

  const interfaceFile =
    typeof raw.interfaceFile === 'string' && raw.interfaceFile.trim() ? raw.interfaceFile.trim() : DEFAULT_WAYFINDING.interfaceFile;
  if (interfaceFile.includes('/') || interfaceFile.includes('\\')) {
    throw new InvalidArchitectureError(`The interface file "${interfaceFile}" must be a file name, like "service.ts".`);
  }
  return { kind: 'wayfinding', srcDir: normalized, interfaceFile };
}

/** "service.ts" → "service": the part the audit compares. */
export function interfaceStem(config: WayfindingConfig): string {
  return config.interfaceFile.replace(/\.[^.]+$/, '');
}

export function architectureLabel(config: ArchitectureConfig): string {
  return `Wayfinding (domains under ${config.srcDir}/, interface ${config.interfaceFile})`;
}
