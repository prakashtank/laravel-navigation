import * as vscode from 'vscode';
import {
  controllerCandidates,
  controllerFileName,
  controllersBase,
} from '../laravel/paths';
import { findExistingFile, findFileUnder } from '../utils/fileFinder';
import { findMethodPosition } from './classResolver';
import { resolvePsr4Path } from '../laravel/psr4';

/**
 * Prefer exact convention paths; shallow-walk Controllers/ if needed.
 * Supports optional method jump (Controller@index / [Ctrl::class, 'index']).
 */
export function resolveController(
  root: string,
  className: string,
  member?: string
): vscode.Location | undefined {
  const withoutMethod = className.replace(/@.*$/, '');
  let uri = findExistingFile([
    ...controllerCandidates(root, withoutMethod),
    ...resolvePsr4Path(root, withoutMethod),
  ]);

  if (!uri) {
    uri = findFileUnder(controllersBase(root), controllerFileName(withoutMethod), {
      maxDirs: 40,
      maxFiles: 200,
      maxDepth: 6,
    });
  }

  if (!uri) {
    return undefined;
  }

  if (member) {
    return new vscode.Location(uri, findMethodPosition(uri.fsPath, member));
  }

  return new vscode.Location(uri, new vscode.Position(0, 0));
}
