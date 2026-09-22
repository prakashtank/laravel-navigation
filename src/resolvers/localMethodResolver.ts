import * as vscode from 'vscode';
import * as fs from 'fs';
import { resolveUseImport } from '../utils/phpHelpers';
import { resolveClass, findMethodPosition } from './classResolver';

/**
 * Resolve $this->method() / self::method() in the current class file.
 * Falls back to one-level parent class (extends) — still no PHP spawn.
 */
export function resolveLocalMethod(
  document: vscode.TextDocument,
  method: string,
  root: string
): vscode.Location | undefined {
  // 1) Same file
  const local = findMethodInText(document.getText(), method);
  if (local !== undefined) {
    return new vscode.Location(document.uri, local);
  }

  // 2) Parent class (one level)
  const parent = findExtendsClass(document);
  if (!parent) {
    return undefined;
  }

  const fqcn = resolveUseImport(document, parent);
  const parentLoc = resolveClass(root, fqcn);
  if (!parentLoc) {
    return undefined;
  }

  const pos = findMethodPosition(parentLoc.uri.fsPath, method);
  // If method not found, still open parent file at top — better skip
  try {
    const text = fs.readFileSync(parentLoc.uri.fsPath, 'utf8');
    if (!new RegExp(`function\\s+${escapeRegExp(method)}\\s*\\(`).test(text)) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return new vscode.Location(parentLoc.uri, pos);
}

function findMethodInText(
  text: string,
  method: string
): vscode.Position | undefined {
  // Cap: only search first 400KB of open document text
  const slice = text.length > 400_000 ? text.slice(0, 400_000) : text;
  const lines = slice.split(/\r?\n/);
  const re = new RegExp(`function\\s+${escapeRegExp(method)}\\s*\\(`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      return new vscode.Position(i, Math.max(0, lines[i].indexOf(method)));
    }
  }
  return undefined;
}

function findExtendsClass(document: vscode.TextDocument): string | undefined {
  const max = Math.min(document.lineCount, 80);
  for (let i = 0; i < max; i++) {
    const line = document.lineAt(i).text;
    const m = line.match(
      /\b(?:class|enum)\s+\w+\s+extends\s+([A-Za-z_][A-Za-z0-9_\\]*)/
    );
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
