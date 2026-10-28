import path from 'node:path';

// An app can opt into an architecture its agents follow. The only one so
// far is Wayfinding (https://github.com/Rifazi/wayfinding-architecture):
// every important decision is owned by exactly one domain, MAP.md indexes
// the domains, each domain's README.md holds its rules, and changes go
// requirement → decision → domain → interface → consumers → segment.
export const WAYFINDING_REPO_URL = 'https://github.com/Rifazi/wayfinding-architecture';

export interface WayfindingConfig {
  kind: 'wayfinding';
  // Repo-relative folders the domains live under (each one a folder with a
  // README.md), e.g. ["server/src", "client/src"] for a repo with two packages.
  srcDirs: string[];
  // A domain's one public file, the only one other domains may import. Matched
  // by stem, so "service.ts" also accepts service.js / service.tsx.
  interfaceFile: string;
}

export type ArchitectureConfig = WayfindingConfig;

export const DEFAULT_WAYFINDING: WayfindingConfig = { kind: 'wayfinding', srcDirs: ['src'], interfaceFile: 'service.ts' };

export const MAP_PATH = 'MAP.md';
export const DOMAIN_DOC = 'README.md';
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

  // srcDir (one folder) is the setting's original shape, still in older apps' config.
  const given = Array.isArray(raw.srcDirs) ? raw.srcDirs : typeof raw.srcDir === 'string' ? [raw.srcDir] : [];
  const srcDirs = [...new Set(given.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map(normalizeSrcDir))];
  if (!srcDirs.length) srcDirs.push(...DEFAULT_WAYFINDING.srcDirs);
  const nested = srcDirs.find((a) => srcDirs.some((b) => a !== b && (b === '.' || a.startsWith(`${b}/`))));
  if (nested) throw new InvalidArchitectureError(`The source folder "${nested}" is inside another one; list only the outer folder.`);

  const interfaceFile =
    typeof raw.interfaceFile === 'string' && raw.interfaceFile.trim() ? raw.interfaceFile.trim() : DEFAULT_WAYFINDING.interfaceFile;
  if (interfaceFile.includes('/') || interfaceFile.includes('\\')) {
    throw new InvalidArchitectureError(`The interface file "${interfaceFile}" must be a file name, like "service.ts".`);
  }
  return { kind: 'wayfinding', srcDirs, interfaceFile };
}

function normalizeSrcDir(srcDir: string): string {
  const normalized = path.posix.normalize(srcDir.trim().replace(/\\/g, '/')).replace(/^\.\/|\/+$/g, '') || '.';
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new InvalidArchitectureError(`The source folder "${srcDir}" must be a path inside the repo, like "src".`);
  }
  return normalized;
}

/**
 * A stored config as the current shape: older apps saved one srcDir. Left
 * as it is if it doesn't parse, so a bad file can't hide the app.
 */
export function normalizeArchitecture(stored: unknown): ArchitectureConfig | undefined {
  try {
    return parseArchitectureConfig(stored) ?? undefined;
  } catch {
    return stored as ArchitectureConfig;
  }
}

/** "src" → "`src/`", "." → "the repo root", several joined with "and". */
export function describeSrcDirs(config: WayfindingConfig, code = (s: string) => `\`${s}\``): string {
  const names = config.srcDirs.map((d) => (d === '.' ? 'the repo root' : code(`${d}/`)));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

/** "service.ts" → "service": the part the audit compares. */
export function interfaceStem(config: WayfindingConfig): string {
  return config.interfaceFile.replace(/\.[^.]+$/, '');
}

export function architectureLabel(config: ArchitectureConfig): string {
  return `Wayfinding (domains under ${describeSrcDirs(config, (s) => s)}, interface ${config.interfaceFile})`;
}
