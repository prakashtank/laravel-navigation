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
  // use \App\Models\User;
  // use App\Services\MetaWebhookService as Hook;
  const fqcnRe = new RegExp(
    `^\\s*use\\s+\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*\\\\${e})\\s*;`
  );
  const aliasRe = new RegExp(
    `^\\s*use\\s+\\\\?([A-Za-z_][A-Za-z0-9_\\\\]*)\\s+as\\s+${e}\\s*;`
  );

  for (let i = 0; i < maxLines; i++) {
    const line = document.lineAt(i).text;
    if (line.includes('namespace ') || line.includes('class ') || line.includes('function ')) {
      // still allow use after namespace; stop once class body likely started
      if (/^\s*(class|interface|trait|enum)\s+/.test(line)) {
        break;
      }
    }
    const grouped = resolveGroupedUse(line, shortOrFqcn);
    if (grouped) {
      return grouped;
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

/** Parse `use` imports from file text (no VS Code document). */
export function parseUseMapFromText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const header = text.split(/\b(?:class|interface|trait|enum)\s+/)[0] ?? text;
  const slice = header.length > 8000 ? header.slice(0, 8000) : header;
  for (const line of slice.split(/\r?\n/)) {
    const grouped = line.match(
      /^\s*use\s+\\?([A-Za-z_][A-Za-z0-9_\\]*)\s*\{([^}]+)\}/
    );
    if (grouped) {
      const prefix = grouped[1].replace(/\\$/, '');
      for (const raw of grouped[2].split(',')) {
        const item = raw.trim();
        if (!item) {
          continue;
        }
        const alias = item.match(
          /^\\?([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/
        );
        if (alias) {
          map.set(alias[2], `${prefix}\\${alias[1]}`);
          continue;
        }
        const name = item.replace(/^\\/, '');
        map.set(name, `${prefix}\\${name}`);
      }
      continue;
    }
    const alias = line.match(
      /^\s*use\s+\\?([A-Za-z_][A-Za-z0-9_\\]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/
    );
    if (alias) {
      map.set(alias[2], alias[1].replace(/^\\/, ''));
      continue;
    }
    const fqcn = line.match(/^\s*use\s+\\?([A-Za-z_][A-Za-z0-9_\\]*)\s*;/);
    if (fqcn) {
      const full = fqcn[1].replace(/^\\/, '');
      const short = full.includes('\\') ? full.split('\\').pop()! : full;
      map.set(short, full);
    }
  }
  return map;
}

export function applyUseMap(map: Map<string, string>, name: string): string {
  const trimmed = name.replace(/^\\/, '');
  if (trimmed.includes('\\')) {
    return trimmed;
  }
  return map.get(trimmed) ?? trimmed;
}

/** use App\Models\{User, Post as Article}; */
function resolveGroupedUse(line: string, short: string): string | undefined {
  const m = line.match(/^\s*use\s+\\?([A-Za-z_][A-Za-z0-9_\\]*)\s*\{([^}]+)\}/);
  if (!m) {
    return undefined;
  }
  const prefix = m[1].replace(/\\$/, '');
  for (const raw of m[2].split(',')) {
    const item = raw.trim();
    if (!item) {
      continue;
    }
    const alias = item.match(
      /^\\?([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/
    );
    if (alias) {
      if (alias[2] === short) {
        return `${prefix}\\${alias[1]}`;
      }
      continue;
    }
    const name = item.replace(/^\\/, '');
    if (name === short) {
      return `${prefix}\\${name}`;
    }
  }
  return undefined;
}
