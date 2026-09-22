import * as vscode from 'vscode';

/**
 * Extract the string literal or identifier under / near the cursor.
 */
export function getWordAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  // Include '.' and '-' so route names like admin.blog-posts.store stay one token
  const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9_\\@.\-]+/);
  return range ? document.getText(range) : '';
}

/**
 * Extract quoted string under cursor if cursor is inside quotes.
 */
export function getStringLiteralAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const line = document.lineAt(position.line).text;
  const col = position.character;

  // Find enclosing single or double quotes
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
      return line.slice(start + 1, end);
    }
  }
  return undefined;
}

export function getLineContext(
  document: vscode.TextDocument,
  position: vscode.Position,
  radius = 1
): string {
  const start = Math.max(0, position.line - radius);
  const end = Math.min(document.lineCount - 1, position.line + radius);
  const lines: string[] = [];
  for (let i = start; i <= end; i++) {
    lines.push(document.lineAt(i).text);
  }
  return lines.join('\n');
}

export function getCurrentLine(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  return document.lineAt(position.line).text;
}

/**
 * Resolve short class name via `use` imports at top of file (first 120 lines).
 * e.g. MetaWebhookService → App\Services\MetaWebhookService
 */
export function resolveUseImport(
  document: vscode.TextDocument,
  shortOrFqcn: string
): string {
  if (shortOrFqcn.includes('\\')) {
    return shortOrFqcn.replace(/^\\/, '');
  }

  const maxLines = Math.min(document.lineCount, 120);
  const e = shortOrFqcn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // use App\Services\MetaWebhookService;
  // use App\Services\MetaWebhookService as Hook;
  const fqcnRe = new RegExp(
    `^\\s*use\\s+([A-Za-z_][A-Za-z0-9_\\\\]*\\\\${e})\\s*;`
  );
  const aliasRe = new RegExp(
    `^\\s*use\\s+([A-Za-z_][A-Za-z0-9_\\\\]*)\\s+as\\s+${e}\\s*;`
  );

  for (let i = 0; i < maxLines; i++) {
    const line = document.lineAt(i).text;
    if (line.includes('namespace ') || line.includes('class ') || line.includes('function ')) {
      // still allow use after namespace; stop once class body likely started
      if (/^\s*(class|interface|trait|enum)\s+/.test(line)) {
        break;
      }
    }
    let m = line.match(fqcnRe);
    if (m) {
      return m[1].replace(/^\\/, '');
    }
    m = line.match(aliasRe);
    if (m) {
      return m[1].replace(/^\\/, '');
    }
  }
  return shortOrFqcn;
}
