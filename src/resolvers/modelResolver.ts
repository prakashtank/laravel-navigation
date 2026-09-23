import * as path from 'path';
import * as vscode from 'vscode';
import { modelCandidates } from '../laravel/paths';
import { findExistingFile, findFileUnder } from '../utils/fileFinder';

/** Convention paths only — no workspace glob. */
export function resolveModel(
  root: string,
  className: string
): vscode.Location | undefined {
  for (const name of expandModelName(className)) {
    const uri = findExistingFile(modelCandidates(root, name));
    if (uri) {
      return new vscode.Location(uri, new vscode.Position(0, 0));
    }
  }
  const short = className.includes('\\')
    ? className.split('\\').pop()!
    : className;
  const nested = findFileUnder(path.join(root, 'app', 'Models'), `${short}.php`, {
    maxDirs: 40,
    maxFiles: 160,
    maxDepth: 4,
  });
  return nested
    ? new vscode.Location(nested, new vscode.Position(0, 0))
    : undefined;
}

/** Prefer App\Models\{Name} when only a short class name is known (Blade heuristics). */
export function expandModelName(className: string): string[] {
  if (className.includes('\\')) {
    return [className.replace(/^\\/, '')];
  }
  return [className, `App\\Models\\${className}`, `App\\${className}`];
}
