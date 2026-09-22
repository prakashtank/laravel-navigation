import * as vscode from 'vscode';
import {
  LaravelDefinitionProvider,
  clearDefinitionCache,
} from './providers/definitionProvider';
import {
  LaravelHoverProvider,
  OPEN_FILE_COMMAND,
  openFileInNewTab,
  registerLaravelHover,
} from './providers/hoverProvider';
import {
  LaravelReferenceProvider,
  clearReferenceCache,
} from './providers/referenceProvider';

/**
 * Lightweight activation:
 * - No PHP / shell / artisan
 * - No file watchers / background indexing
 * - Work only on hover, Ctrl+Click, Find All References (routes)
 */
export function activate(context: vscode.ExtensionContext): void {
  // One selector list → one HoverProvider (avoid duplicate cards)
  const selector: vscode.DocumentSelector = [
    { language: 'php', scheme: 'file' },
    { language: 'blade', scheme: 'file' },
    { language: 'laravel-blade', scheme: 'file' },
  ];

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      selector,
      new LaravelDefinitionProvider()
    ),
    vscode.languages.registerReferenceProvider(
      selector,
      new LaravelReferenceProvider()
    ),
    vscode.commands.registerCommand(OPEN_FILE_COMMAND, openFileInNewTab),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearDefinitionCache();
      clearReferenceCache();
    })
  );

  registerLaravelHover(context, selector);
}

export function deactivate(): void {
  clearDefinitionCache();
  clearReferenceCache();
}
