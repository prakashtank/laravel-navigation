import * as vscode from 'vscode';
import * as fs from 'fs';
import { configFilePath } from '../laravel/paths';
import { getEnvValue } from './envResolver';

const MAX_CONFIG_BYTES = 128 * 1024;

/** Open config file via fs only — never boot PHP. */
export function resolveConfig(
  root: string,
  configKey: string
): vscode.Location | undefined {
  const filePath = configFilePath(root, configKey);
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const uri = vscode.Uri.file(filePath);
  const position = findConfigKeyPosition(filePath, configKey);
  return new vscode.Location(uri, position);
}

/**
 * Best-effort display value for hover:
 * - literal from config line
 * - or resolved env('KEY') / env("KEY", 'default')
 */
export function getConfigDisplayValue(
  root: string,
  configKey: string
): string | undefined {
  const filePath = configFilePath(root, configKey);
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_CONFIG_BYTES) {
      return undefined;
    }
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const segments = configKey.split('.').slice(1);
    if (segments.length === 0) {
      return undefined;
    }
    const hit = walkNestedKeyLine(lines, segments);
    if (!hit) {
      return undefined;
    }
    const raw = extractPhpValue(lines[hit.line]);
    if (raw === undefined) {
      return undefined;
    }

    const envCall = raw.match(
      /^env\(\s*['"]([^'"]+)['"]\s*(?:,\s*(.+))?\)\s*,?$/
    );
    if (envCall) {
      const envVal = getEnvValue(root, envCall[1]);
      if (envVal !== undefined) {
        return envVal;
      }
      if (envCall[2]) {
        return stripPhpLiteral(envCall[2].replace(/,\s*$/, '').trim());
      }
      return undefined;
    }

    return stripPhpLiteral(raw);
  } catch {
    return undefined;
  }
}

function walkNestedKeyLine(
  lines: string[],
  segments: string[]
): { line: number } | undefined {
  let from = 0;
  let to = lines.length;
  let last: { line: number } | undefined;

  for (let i = 0; i < segments.length; i++) {
    const hit = findKeyInScope(lines, from, segments[i], to);
    if (!hit) {
      return last;
    }
    last = { line: hit.line };
    if (i < segments.length - 1) {
      from = hit.line + 1;
      to = findScopeEnd(lines, hit.line);
    }
  }
  return last;
}

function extractPhpValue(line: string): string | undefined {
  const m = line.match(/=>\s*(.+)$/);
  if (!m) {
    return undefined;
  }
  return m[1].trim().replace(/,\s*$/, '');
}

function stripPhpLiteral(raw: string): string {
  const t = raw.trim().replace(/,\s*$/, '');
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function findConfigKeyPosition(filePath: string, configKey: string): vscode.Position {
  const segments = configKey.split('.').slice(1);
  if (segments.length === 0) {
    return new vscode.Position(0, 0);
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_CONFIG_BYTES) {
      return new vscode.Position(0, 0);
    }
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    return walkNestedKeys(lines, segments);
  } catch {
    return new vscode.Position(0, 0);
  }
}

function walkNestedKeys(lines: string[], segments: string[]): vscode.Position {
  let from = 0;
  let to = lines.length;
  let last = new vscode.Position(0, 0);

  for (let i = 0; i < segments.length; i++) {
    const hit = findKeyInScope(lines, from, segments[i], to);
    if (!hit) {
      return last;
    }
    last = hit.position;
    if (i < segments.length - 1) {
      from = hit.line + 1;
      to = findScopeEnd(lines, hit.line);
    }
  }
  return last;
}

function findKeyInScope(
  lines: string[],
  from: number,
  key: string,
  to: number
): { line: number; position: vscode.Position } | undefined {
  const re = new RegExp(`['"]${escapeRegExp(key)}['"]\\s*=>`);
  for (let i = from; i < to && i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m && m.index !== undefined) {
      return {
        line: i,
        position: new vscode.Position(i, m.index + 1),
      };
    }
  }
  return undefined;
}

function findScopeEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '[' || ch === '(') {
        depth++;
        started = true;
      } else if (ch === ']' || ch === ')') {
        depth--;
        if (started && depth <= 0) {
          return i + 1;
        }
      }
    }
    if (i === startLine && !line.includes('[') && !line.includes('(')) {
      return startLine + 1;
    }
  }
  return lines.length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
