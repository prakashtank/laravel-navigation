import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Cheap sync existence check only — never scans the workspace.
 */
export function findExistingFile(candidates: string[]): vscode.Uri | undefined {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return vscode.Uri.file(candidate);
      }
    } catch {
      // ignore permission errors
    }
  }
  return undefined;
}

/**
 * Shallow walk under a single directory (e.g. app/Http/Controllers).
 * Caps directories/files so large trees cannot burn CPU.
 */
export function findFileUnder(
  baseDir: string,
  fileName: string,
  options: { maxDirs?: number; maxFiles?: number; maxDepth?: number } = {}
): vscode.Uri | undefined {
  const maxDirs = options.maxDirs ?? 40;
  const maxFiles = options.maxFiles ?? 200;
  const maxDepth = options.maxDepth ?? 6;

  if (!fs.existsSync(baseDir)) {
    return undefined;
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: baseDir, depth: 0 }];
  let dirsSeen = 0;
  let filesSeen = 0;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      break;
    }
    if (dirsSeen >= maxDirs || filesSeen >= maxFiles) {
      break;
    }
    dirsSeen++;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (filesSeen >= maxFiles) {
        break;
      }
      const full = path.join(item.dir, entry.name);
      if (entry.isFile()) {
        filesSeen++;
        if (entry.name === fileName) {
          return vscode.Uri.file(full);
        }
      } else if (entry.isDirectory() && item.depth < maxDepth) {
        // skip heavy / irrelevant folders
        if (entry.name === 'vendor' || entry.name === 'node_modules' || entry.name.startsWith('.')) {
          continue;
        }
        queue.push({ dir: full, depth: item.depth + 1 });
      }
    }
  }

  return undefined;
}
