import * as vscode from 'vscode';
import { findNamedRoute } from '../laravel/routeIndex';

export function resolveRoute(
  root: string,
  routeName: string
): vscode.Location | undefined {
  return findNamedRoute(root, routeName);
}
