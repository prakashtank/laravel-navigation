import * as vscode from 'vscode';
import { resolveAtPosition, clearResolveCache } from '../resolve/resolveSymbol';
import { clearPreviewCache } from '../utils/preview';
import { clearReferenceCache } from './referenceProvider';

export class LaravelDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.Definition | undefined {
    const resolved = resolveAtPosition(document, position, token);
    if (!resolved) {
      return undefined;
    }
    return resolved.locations ?? resolved.location;
  }
}

export function clearDefinitionCache(): void {
  clearResolveCache();
  clearPreviewCache();
  clearReferenceCache();
}
