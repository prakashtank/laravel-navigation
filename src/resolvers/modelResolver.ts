import * as vscode from 'vscode';
import { modelCandidates } from '../laravel/paths';
import { findExistingFile } from '../utils/fileFinder';

/** Convention paths only — no workspace glob. */
export function resolveModel(
  root: string,
  className: string
): vscode.Location | undefined {
  const uri = findExistingFile(modelCandidates(root, className));
  if (!uri) {
    return undefined;
  }
  return new vscode.Location(uri, new vscode.Position(0, 0));
}

/** Prefer App\Models\{Name} when only a short class name is known (Blade heuristics). */
export function expandModelName(className: string): string[] {
  if (className.includes('\\')) {
    return [className.replace(/^\\/, '')];
  }
  return [className, `App\\Models\\${className}`, `App\\${className}`];
}
