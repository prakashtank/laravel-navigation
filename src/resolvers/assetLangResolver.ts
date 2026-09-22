import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { findExistingFile } from '../utils/fileFinder';
import { getConfigDisplayValue } from './configResolver';

/** asset('js/app.js') → public/js/app.js (+ build fallbacks) */
export function resolveAsset(
  root: string,
  assetPath: string
): vscode.Location | undefined {
  const cleaned = assetPath.replace(/^\//, '');
  const candidates = [
    path.join(root, 'public', cleaned),
    path.join(root, 'public', 'build', cleaned),
    path.join(root, 'resources', cleaned),
  ];
  const uri = findExistingFile(candidates);
  return uri
    ? new vscode.Location(uri, new vscode.Position(0, 0))
    : undefined;
}

/** @vite('resources/js/app.js') → that file under project root */
export function resolveVite(
  root: string,
  entry: string
): vscode.Location | undefined {
  const cleaned = entry.replace(/^\//, '');
  const candidates = [
    path.join(root, cleaned),
    path.join(root, 'resources', 'js', path.basename(cleaned)),
    path.join(root, 'resources', 'css', path.basename(cleaned)),
  ];
  const uri = findExistingFile(candidates);
  return uri
    ? new vscode.Location(uri, new vscode.Position(0, 0))
    : undefined;
}

/**
 * __('messages.welcome') / trans() / @lang()
 * → lang/{locale}/messages.php or resources/lang/...
 */
export function resolveLang(
  root: string,
  key: string
): vscode.Location | undefined {
  // JSON-style full string without file.key — skip heavy search
  if (!key.includes('.')) {
    const jsonHit = findJsonLang(root, key);
    if (jsonHit) {
      return jsonHit;
    }
  }

  const file = key.split('.')[0];
  const locales = guessLocales(root);
  const candidates: string[] = [];
  for (const loc of locales) {
    candidates.push(
      path.join(root, 'lang', loc, `${file}.php`),
      path.join(root, 'resources', 'lang', loc, `${file}.php`),
      path.join(root, 'lang', `${file}.php`)
    );
  }

  const uri = findExistingFile(candidates);
  if (!uri) {
    return undefined;
  }

  const nestedKey = key.split('.').slice(1).join('.');
  if (!nestedKey) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }

  const pos = findLangKeyPosition(uri.fsPath, nestedKey.split('.'));
  return new vscode.Location(uri, pos);
}

function guessLocales(root: string): string[] {
  const locales = ['en'];
  const fromConfig = getConfigDisplayValue(root, 'app.locale');
  if (fromConfig && /^[a-zA-Z_]+$/.test(fromConfig) && fromConfig !== 'en') {
    locales.unshift(fromConfig);
  }
  const fallback = getConfigDisplayValue(root, 'app.fallback_locale');
  if (
    fallback &&
    /^[a-zA-Z_]+$/.test(fallback) &&
    !locales.includes(fallback)
  ) {
    locales.push(fallback);
  }
  return locales;
}

function findJsonLang(
  root: string,
  key: string
): vscode.Location | undefined {
  const locales = guessLocales(root);
  for (const loc of locales) {
    const files = [
      path.join(root, 'lang', `${loc}.json`),
      path.join(root, 'resources', 'lang', `${loc}.json`),
    ];
    for (const file of files) {
      if (!fs.existsSync(file)) {
        continue;
      }
      try {
        const stat = fs.statSync(file);
        if (stat.size > 256 * 1024) {
          continue;
        }
        const text = fs.readFileSync(file, 'utf8');
        const needle = `"${key}"`;
        const idx = text.indexOf(needle);
        if (idx >= 0) {
          const line = text.slice(0, idx).split(/\r?\n/).length - 1;
          return new vscode.Location(
            vscode.Uri.file(file),
            new vscode.Position(line, 0)
          );
        }
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

function findLangKeyPosition(
  filePath: string,
  segments: string[]
): vscode.Position {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 128 * 1024) {
      return new vscode.Position(0, 0);
    }
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    // Prefer deepest key match within file (same as simple config)
    for (let d = segments.length - 1; d >= 0; d--) {
      const key = segments[d];
      const re = new RegExp(`['"]${escapeRegExp(key)}['"]\\s*=>`);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          return new vscode.Position(i, Math.max(0, lines[i].indexOf(key)));
        }
      }
    }
  } catch {
    // ignore
  }
  return new vscode.Position(0, 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
