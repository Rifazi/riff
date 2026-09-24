#!/usr/bin/env node
// Runs as postinstall — makes `npm start` a genuine one-command start on a
// fresh clone: creates backend/.env from the example if it doesn't exist,
// and tries to auto-detect a sibling Customer-EDI checkout for
// TARGET_REPO_ROOT so the developer doesn't have to type an absolute path.
// Provider API keys are configured from the running app's Settings page, not
// here — this script has nothing to do with them.
import { existsSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, '..');
const envPath = path.join(projectRoot, 'backend', '.env');
const examplePath = path.join(projectRoot, 'backend', '.env.example');

function looksLikeCustomerEdi(dir) {
  return existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'docs'));
}

function findSiblingCustomerEdi() {
  const parent = path.join(projectRoot, '..');
  const explicit = path.join(parent, 'Customer-EDI');
  if (looksLikeCustomerEdi(explicit)) return explicit;

  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(parent, entry.name);
      if (candidate === projectRoot) continue;
      if (looksLikeCustomerEdi(candidate)) return candidate;
    }
  } catch {
    // parent directory not readable — skip auto-detection
  }
  return null;
}

if (!existsSync(envPath) && existsSync(examplePath)) {
  copyFileSync(examplePath, envPath);
  console.log('[harness] created backend/.env');

  const detected = findSiblingCustomerEdi();
  if (detected) {
    const contents = readFileSync(envPath, 'utf8');
    writeFileSync(envPath, contents.replace(/^TARGET_REPO_ROOT=.*/m, `TARGET_REPO_ROOT=${detected}`), 'utf8');
    console.log(`[harness] auto-detected Customer-EDI at ${detected} — set TARGET_REPO_ROOT.`);
  } else {
    console.log('[harness] could not auto-detect a sibling Customer-EDI checkout — set TARGET_REPO_ROOT in backend/.env yourself.');
  }
}

if (existsSync(envPath)) {
  const contents = readFileSync(envPath, 'utf8');
  const target = /^TARGET_REPO_ROOT=(.*)$/m.exec(contents);
  if (!target || !target[1].trim() || !looksLikeCustomerEdi(target[1].trim())) {
    console.log('[harness] TARGET_REPO_ROOT in backend/.env is missing or does not look like the Customer-EDI repo.');
  }
}

console.log('[harness] add provider API keys from the Settings page once the app is running.');
