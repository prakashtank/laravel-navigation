import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LruCache } from '../utils/cache';

interface EnvFile {
  /** key -> { value, line (0-based) } */
  entries: Map<string, { value: string; line: number }>;
  signature: string;
  filePath: string;
}

const envCache = new LruCache<EnvFile>(15);
const MAX_ENV_BYTES = 256 * 1024;

export function resolveEnv(
  root: string,
  key: string
): vscode.Location | undefined {
  const env = loadEnv(root);
  if (!env) {
    return undefined;
  }
  const hit = env.entries.get(key);
  if (!hit) {
    // Still open .env at top if file exists but key missing
    return new vscode.Location(vscode.Uri.file(env.filePath), new vscode.Position(0, 0));
  }
  return new vscode.Location(
    vscode.Uri.file(env.filePath),
    new vscode.Position(hit.line, 0)
  );
}

export function getEnvValue(root: string, key: string): string | undefined {
  const env = loadEnv(root);
  return env?.entries.get(key)?.value;
}

function loadEnv(root: string): EnvFile | undefined {
  const candidates = [
    path.join(root, '.env'),
    path.join(root, '.env.local'),
  ];
  let filePath: string | undefined;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      filePath = c;
      break;
    }
  }
  if (!filePath) {
    return undefined;
  }

  let mtime = 0;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
  const signature = `${filePath}:${mtime}`;
  const cached = envCache.get(root);
  if (cached && cached.signature === signature) {
    return cached;
  }

  const entries = new Map<string, { value: string; line: number }>();
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ENV_BYTES) {
      return undefined;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.startsWith('#')) {
        continue;
      }
      const line = raw.startsWith('export ') ? raw.slice(7).trim() : raw;
      const eq = line.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        continue;
      }
      let value = line.slice(eq + 1).trim();
      // Strip inline comment for unquoted values
      if (
        !value.startsWith('"') &&
        !value.startsWith("'") &&
        value.includes(' #')
      ) {
        value = value.replace(/\s+#.*$/, '');
      }
      value = unquote(value);
      if (!entries.has(key)) {
        entries.set(key, { value, line: i });
      }
    }
  } catch {
    return undefined;
  }

  const result: EnvFile = { entries, signature, filePath };
  envCache.set(root, result);
  return result;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function clearEnvCache(): void {
  envCache.clear();
}
