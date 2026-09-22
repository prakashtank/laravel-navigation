import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LruCache } from '../utils/cache';

type RootResult = { root: string | undefined };

/** Cache by start directory — stores explicit miss as { root: undefined }. */
const rootByStartDir = new LruCache<RootResult>(80);
const MAX_WALK_DEPTH = 12;

/**
 * Find Laravel project root by walking up — sync, depth-capped, cached.
 * Never runs PHP / artisan / composer.
 */
export function findLaravelRoot(fileUri: vscode.Uri): string | undefined {
  const startDir = path.dirname(fileUri.fsPath);
  const cached = rootByStartDir.get(startDir);
  if (cached) {
    return cached.root;
  }

  let current = startDir;
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  let depth = 0;

  while (depth < MAX_WALK_DEPTH) {
    if (isLaravelRoot(current)) {
      rootByStartDir.set(startDir, { root: current });
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    const stillInWorkspace =
      workspaceFolders.length === 0 ||
      workspaceFolders.some(
        (folder) =>
          current === folder.uri.fsPath ||
          current.startsWith(folder.uri.fsPath + path.sep)
      );
    if (!stillInWorkspace) {
      break;
    }

    current = parent;
    depth++;
  }

  for (const folder of workspaceFolders) {
    const root = folder.uri.fsPath;
    if (isLaravelRoot(root)) {
      rootByStartDir.set(startDir, { root });
      return root;
    }
  }

  rootByStartDir.set(startDir, { root: undefined });
  return undefined;
}

function isLaravelRoot(dir: string): boolean {
  try {
    if (fs.existsSync(path.join(dir, 'artisan'))) {
      return true;
    }
    return (
      fs.existsSync(path.join(dir, 'composer.json')) &&
      fs.existsSync(path.join(dir, 'app')) &&
      fs.existsSync(path.join(dir, 'config'))
    );
  } catch {
    return false;
  }
}

export function clearLaravelRootCache(): void {
  rootByStartDir.clear();
}
