import * as vscode from 'vscode';
import { viewCandidates } from '../laravel/paths';
import { findExistingFile } from '../utils/fileFinder';

/** Convention paths only — no workspace glob. */
export function resolveView(
  root: string,
  viewName: string
): vscode.Location | undefined {
  const uri = findExistingFile(viewCandidates(root, viewName));
  if (!uri) {
    return undefined;
  }
  return new vscode.Location(uri, new vscode.Position(0, 0));
}
