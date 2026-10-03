import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

// Where the Riff app keeps things this server reuses (its models, its binaries).

export function riffEnv(name: string): string | undefined {
  return process.env[`RIFF_${name}`] || process.env[`MEETILY_${name}`] || undefined;
}

export function riffDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/com.rifaz.riff');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'com.rifaz.riff');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local/share'), 'com.rifaz.riff');
}

/** The Riff checkout this server lives in. */
export function riffRoot(): string {
  return path.resolve(config.harnessRoot, '..');
}
