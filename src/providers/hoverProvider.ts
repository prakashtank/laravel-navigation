import * as vscode from 'vscode';
import * as path from 'path';
import { resolveAtPosition } from '../resolve/resolveSymbol';
import { readFilePreview, readPreviewAroundLine } from '../utils/preview';

export const OPEN_FILE_COMMAND = 'laravelNavigation.openFile';
/** Shown once in hover footer — change with package.json version */
export const BRAND = 'laravel-navigation 1.0.0';
export const AUTHOR_NAME = 'Prakash Tank';
export const AUTHOR_EMAIL = 'prakashtank106@gmail.com';
export const FEEDBACK_MAILTO =
  `mailto:${AUTHOR_EMAIL}?subject=${encodeURIComponent('laravel-navigation feedback')}&body=${encodeURIComponent('Hi Prakash,\n\nFeedback about laravel-navigation:\n\n')}`;

let providerRegistered = false;

/** Prevent double-register if activate() runs twice in the same extension host. */
export function registerLaravelHover(
  context: vscode.ExtensionContext,
  selector: vscode.DocumentSelector
): void {
  if (providerRegistered) {
    return;
  }
  providerRegistered = true;
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, new LaravelHoverProvider())
  );
}

export class LaravelHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.Hover | undefined {
    if (token.isCancellationRequested) {
      return undefined;
    }

    const resolved = resolveAtPosition(document, position, token);
    if (!resolved) {
      return undefined;
    }

    const { symbol, location, displayValue } = resolved;
    const filePath = location.uri.fsPath;
    const fileName = path.basename(filePath);
    const relative = vscode.workspace.asRelativePath(location.uri, false);
    const lang = fileName.endsWith('.blade.php')
      ? 'blade'
      : fileName === '.env' || fileName.startsWith('.env')
        ? 'dotenv'
        : 'php';

    const openArgs = encodeURIComponent(
      JSON.stringify([
        location.uri.toString(),
        location.range.start.line,
        location.range.start.character,
      ])
    );
    const openLink = `command:${OPEN_FILE_COMMAND}?${openArgs}`;
    const kindLabel = kindLabelFor(symbol.kind);
    const member =
      symbol.member !== undefined ? ` \`::${symbol.member}()\`` : '';

    const sameFile = location.uri.fsPath === document.uri.fsPath;
    const lines: string[] = [
      `**${kindLabel}**${member} · [${fileName}](${openLink})`,
      `\`${relative}\``,
    ];

    if (symbol.kind === 'route') {
      lines.push(
        displayValue !== undefined
          ? `**URL:** \`${displayValue}\``
          : `**URL:** _unknown_`
      );
    } else if (symbol.kind === 'env' || symbol.kind === 'config') {
      lines.push(
        displayValue !== undefined
          ? `**Value:** \`${displayValue}\``
          : `**Value:** _not found_`
      );
    }

    // One code fence only — skip when target is the same file (avoids "duplicate" look)
    let code: string | undefined;
    if (symbol.kind === 'env' && displayValue !== undefined) {
      code = `${symbol.value}=${displayValue}`;
    } else if (symbol.kind === 'route') {
      code = readPreviewAroundLine(filePath, location.range.start.line);
    } else if (symbol.kind === 'config') {
      code = readFilePreview(filePath);
    } else if (!sameFile) {
      code =
        symbol.member !== undefined || symbol.kind === 'localMethod'
          ? readPreviewAroundLine(filePath, location.range.start.line)
          : readFilePreview(filePath);
    } else if (
      symbol.kind === 'localMethod' ||
      symbol.kind === 'instanceMethod' ||
      symbol.kind === 'relation'
    ) {
      // Same file: one signature line only (no big preview that repeats the hover)
      code = readSingleLine(filePath, location.range.start.line);
    }

    let body = lines.join('  \n');
    if (code && code.trim()) {
      const fenceLang =
        symbol.kind === 'env' ? 'dotenv' : lang;
      body += `\n\n\`\`\`${fenceLang}\n${trimCode(code)}\n\`\`\``;
    }
    body += `\n\n_${BRAND}_ · [${AUTHOR_NAME}](${FEEDBACK_MAILTO})`;

    // Single MarkdownString constructed once — multiple appendMarkdown can duplicate in Cursor
    const md = new vscode.MarkdownString(body, true);
    md.isTrusted = true;
    md.supportHtml = false;

    const wordRange =
      document.getWordRangeAtPosition(position, /[A-Za-z0-9_\\@.\-]+/) ??
      stringLiteralRange(document, position) ??
      new vscode.Range(position, position);

    return new vscode.Hover(md, wordRange);
  }
}

function readSingleLine(filePath: string, line: number): string {
  const block = readPreviewAroundLine(filePath, line);
  if (!block) {
    return '';
  }
  // Around-line helper may include neighbors; keep the target line when possible
  const parts = block.split(/\r?\n/).filter((l) => l !== '// …');
  if (parts.length === 0) {
    return '';
  }
  // Prefer the line that looks like a function signature
  const sig = parts.find((l) => /\bfunction\s+\w+/.test(l));
  return (sig ?? parts[Math.min(2, parts.length - 1)]).trim();
}

function trimCode(code: string): string {
  const lines = code.split(/\r?\n/);
  if (lines.length <= 8) {
    return code.trimEnd();
  }
  return lines.slice(0, 8).join('\n').trimEnd() + '\n// …';
}

function stringLiteralRange(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.Range | undefined {
  const line = document.lineAt(position.line).text;
  const col = position.character;
  for (const quote of ["'", '"']) {
    let start = -1;
    for (let i = col; i >= 0; i--) {
      if (line[i] === quote && (i === 0 || line[i - 1] !== '\\')) {
        start = i;
        break;
      }
    }
    if (start < 0) {
      continue;
    }
    let end = -1;
    for (let i = start + 1; i < line.length; i++) {
      if (line[i] === quote && line[i - 1] !== '\\') {
        end = i;
        break;
      }
    }
    if (end > start && col >= start && col <= end) {
      return new vscode.Range(position.line, start + 1, position.line, end);
    }
  }
  return undefined;
}

export async function openFileInNewTab(
  uriString: string,
  line?: number,
  character?: number
): Promise<void> {
  const uri = vscode.Uri.parse(uriString);
  const pos = new vscode.Position(line ?? 0, character ?? 0);
  await vscode.window.showTextDocument(uri, {
    preview: false,
    preserveFocus: false,
    selection: new vscode.Range(pos, pos),
  });
}

function kindLabelFor(kind: string): string {
  const labels: Record<string, string> = {
    model: 'Model',
    view: 'View',
    config: 'Config',
    env: 'Env',
    asset: 'Asset',
    vite: 'Vite',
    lang: 'Lang',
    controller: 'Controller',
    route: 'Route',
    class: 'Class',
    trait: 'Trait',
    middleware: 'Middleware',
    job: 'Job',
    event: 'Event',
    listener: 'Listener',
    policy: 'Policy',
    request: 'Form Request',
    localMethod: 'Method',
    instanceMethod: 'Method',
    relation: 'Relation',
  };
  return labels[kind] ?? kind;
}
