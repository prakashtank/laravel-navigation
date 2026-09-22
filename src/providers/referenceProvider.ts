import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectSymbol } from '../detect/symbolDetector';
import { findLaravelRoot } from '../laravel/project';
import { LruCache } from '../utils/cache';

const MAX_FILES = 80;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_DIRS = 60;

const usageCache = new LruCache<vscode.Location[]>(40);

/**
 * Find references to a named route (reverse lookup from definition / route()).
 * Capped filesystem scan — no PHP, no workspace.findFiles.
 */
export class LaravelReferenceProvider implements vscode.ReferenceProvider {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    token: vscode.CancellationToken
  ): vscode.Location[] | undefined {
    if (token.isCancellationRequested || document.uri.scheme !== 'file') {
      return undefined;
    }

    const symbol = detectSymbol(document, position);
    if (!symbol || symbol.kind !== 'route') {
      return undefined;
    }

    const root = findLaravelRoot(document.uri);
    if (!root) {
      return undefined;
    }

    return findRouteUsages(root, symbol.value);
  }
}

export function findRouteUsages(root: string, routeName: string): vscode.Location[] {
  const cacheKey = `${root}|${routeName}`;
  const cached = usageCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const locations: vscode.Location[] = [];
  const roots = [
    path.join(root, 'routes'),
    path.join(root, 'app'),
    path.join(root, 'resources', 'views'),
  ];

  for (const dir of roots) {
    if (locations.length >= 50) {
      break;
    }
    scanDirForRoute(dir, routeName, locations, { files: 0, dirs: 0 });
  }

  usageCache.set(cacheKey, locations);
  return locations;
}

function scanDirForRoute(
  dir: string,
  routeName: string,
  out: vscode.Location[],
  counters: { files: number; dirs: number }
): void {
  if (!fs.existsSync(dir) || out.length >= 50) {
    return;
  }

  const queue = [dir];
  const needlePatterns = [
    new RegExp(`\\broute\\s*\\(\\s*['"]${escapeRegExp(routeName)}['"]`),
    new RegExp(`\\bto_route\\s*\\(\\s*['"]${escapeRegExp(routeName)}['"]`),
    new RegExp(`->route\\s*\\(\\s*['"]${escapeRegExp(routeName)}['"]`),
    new RegExp(`->name\\s*\\(\\s*['"]${escapeRegExp(routeName)}['"]`),
    new RegExp(`\\brouteIs\\s*\\(\\s*['"]${escapeRegExp(routeName)}['"]`),
  ];

  while (queue.length && counters.files < MAX_FILES && counters.dirs < MAX_DIRS) {
    const current = queue.shift()!;
    counters.dirs++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= 50 || counters.files >= MAX_FILES) {
        return;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'vendor' ||
          entry.name === 'node_modules' ||
          entry.name === 'storage' ||
          entry.name.startsWith('.')
        ) {
          continue;
        }
        queue.push(full);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.php') || entry.name.endsWith('.blade.php'))
      ) {
        counters.files++;
        collectInFile(full, needlePatterns, out);
      }
    }
  }
}

function collectInFile(
  file: string,
  patterns: RegExp[],
  out: vscode.Location[]
): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) {
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const uri = vscode.Uri.file(file);
    for (let i = 0; i < lines.length; i++) {
      for (const re of patterns) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          out.push(new vscode.Location(uri, new vscode.Position(i, 0)));
          break;
        }
      }
      if (out.length >= 50) {
        return;
      }
    }
  } catch {
    // ignore
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function clearReferenceCache(): void {
  usageCache.clear();
}
