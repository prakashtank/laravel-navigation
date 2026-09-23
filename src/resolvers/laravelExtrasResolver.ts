import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LruCache } from '../utils/cache';
import { findExistingFile, findFileUnder } from '../utils/fileFinder';
import { resolvePsr4Path } from '../laravel/psr4';
import { findMethodPosition, resolveByConvention, resolveClass } from './classResolver';
import { expandModelName, resolveModel } from './modelResolver';

const MAX_FILE_BYTES = 128 * 1024;
const commandCache = new LruCache<Map<string, { file: string; line: number }>>(8);
const migrationCache = new LruCache<Map<string, { file: string; line: number }>>(8);
const listenCache = new LruCache<Map<string, string[]>>(8);
const gateCache = new LruCache<Map<string, { file: string; line: number }>>(8);

export function resolveCommandSignature(
  root: string,
  signature: string
): vscode.Location | undefined {
  const name = signature.trim().split(/\s+/)[0];
  if (!name) {
    return undefined;
  }
  const map = loadCommandIndex(root);
  const hit = map.get(name);
  if (!hit) {
    return undefined;
  }
  return new vscode.Location(
    vscode.Uri.file(hit.file),
    new vscode.Position(hit.line, 0)
  );
}

export function resolveMigration(
  root: string,
  tableOrClass: string
): vscode.Location | undefined {
  const map = loadMigrationIndex(root);
  const hit =
    map.get(tableOrClass) ??
    map.get(tableOrClass.replace(/Table$/, '')) ??
    findMigrationByFilename(root, tableOrClass);
  if (hit) {
    return new vscode.Location(
      vscode.Uri.file(hit.file),
      new vscode.Position(hit.line, 0)
    );
  }
  const short = tableOrClass.includes('\\')
    ? tableOrClass.split('\\').pop()!
    : tableOrClass;
  const found = findFileUnder(path.join(root, 'database', 'migrations'), `${short}.php`, {
    maxDirs: 10,
    maxFiles: 80,
    maxDepth: 2,
  });
  return found
    ? new vscode.Location(found, new vscode.Position(0, 0))
    : undefined;
}

export function resolveFactory(
  root: string,
  modelOrFactory: string
): vscode.Location | undefined {
  const short = modelOrFactory.includes('\\')
    ? modelOrFactory.split('\\').pop()!
    : modelOrFactory;
  const factoryName = /Factory$/.test(short) ? short : `${short}Factory`;
  const candidates = [
    ...resolvePsr4Path(root, factoryName),
    ...resolvePsr4Path(root, `Database\\Factories\\${factoryName}`),
    path.join(root, 'database', 'factories', `${factoryName}.php`),
  ];
  const uri = findExistingFile(candidates);
  if (uri) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
  const found = findFileUnder(
    path.join(root, 'database', 'factories'),
    `${factoryName}.php`,
    { maxDirs: 15, maxFiles: 80, maxDepth: 3 }
  );
  return found
    ? new vscode.Location(found, new vscode.Position(0, 0))
    : undefined;
}

export function resolvePolicyAbility(
  root: string,
  modelName: string,
  ability: string
): vscode.Location | undefined {
  const short = modelName.includes('\\')
    ? modelName.split('\\').pop()!
    : modelName;
  const policyName = /Policy$/.test(short) ? short : `${short}Policy`;
  const names = modelName.includes('\\')
    ? [modelName.replace(/Model(s)?\\[^\\]+$/, `Policies\\${policyName}`), policyName]
    : expandModelName(modelName).map((n) =>
        n.includes('\\')
          ? n.replace(/Models\\[^\\]+$/, `Policies\\${policyName}`)
          : policyName
      );
  names.push(`App\\Policies\\${policyName}`, policyName);

  for (const name of [...new Set(names)]) {
    const loc =
      resolveByConvention(root, 'policy', name) ?? resolveClass(root, name, ability);
    if (loc) {
      if (ability) {
        return new vscode.Location(
          loc.uri,
          findMethodPosition(loc.uri.fsPath, ability)
        );
      }
      return loc;
    }
  }

  const guessed = guessModelName(modelName);
  if (guessed && guessed !== short) {
    return resolvePolicyAbility(root, guessed, ability);
  }
  return undefined;
}

export function resolveGateDefine(
  root: string,
  ability: string
): vscode.Location | undefined {
  const name = ability.trim();
  if (!name) {
    return undefined;
  }
  const map = loadGateIndex(root);
  const hit = map.get(name);
  if (!hit) {
    return undefined;
  }
  return new vscode.Location(
    vscode.Uri.file(hit.file),
    new vscode.Position(hit.line, 0)
  );
}

export function resolveEventListeners(
  root: string,
  eventName: string
): vscode.Location[] {
  const map = loadEventListenIndex(root);
  const short = eventName.includes('\\')
    ? eventName.split('\\').pop()!
    : eventName;
  const listeners =
    map.get(eventName) ??
    map.get(short) ??
    map.get(eventName.replace(/^\\/, '')) ??
    [];
  const out: vscode.Location[] = [];
  for (const listener of listeners) {
    const loc =
      resolveByConvention(root, 'listener', listener) ??
      resolveClass(root, listener);
    if (loc) {
      out.push(loc);
    }
  }
  return out;
}

export function inferAuthorizeModel(
  document: vscode.TextDocument,
  position: vscode.Position,
  ctx: string
): string | undefined {
  const m = ctx.match(
    /(?:authorize(?:ForUser)?|Gate::(?:allows|denies|authorize|check|any|none|inspect)|@can(?:any)?)\s*\(\s*['"][^'"]+['"]\s*,\s*([^,\)]+)/
  );
  if (!m) {
    return undefined;
  }
  return modelFromAuthorizeArg(document, position, m[1].trim());
}

export function modelFromAuthorizeArg(
  document: vscode.TextDocument,
  position: vscode.Position,
  raw: string
): string | undefined {
  const classRef = raw.match(/([A-Za-z_\\][A-Za-z0-9_\\]*)::class/);
  if (classRef) {
    return classRef[1].replace(/^\\/, '');
  }
  const varRef = raw.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!varRef) {
    return undefined;
  }
  const start = Math.max(0, position.line - 200);
  const e = varRef[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paramRe = new RegExp(`(\\\\?[A-Z][A-Za-z0-9_\\\\]*)\\s+\\$${e}\\b`);
  let type: string | undefined;
  for (let i = start; i <= position.line; i++) {
    const line = document.lineAt(i).text;
    const hit = line.match(paramRe);
    if (hit) {
      type = hit[1].replace(/^\\/, '');
    }
    const doc = line.match(
      new RegExp(`@var\\s+(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)\\s+\\$${e}\\b`)
    );
    if (doc) {
      type = doc[1].replace(/^\\/, '');
    }
  }
  if (type) {
    return type;
  }
  return guessModelName(varRef[1]);
}

function guessModelName(name: string): string | undefined {
  const short = name.includes('\\') ? name.split('\\').pop()! : name;
  if (/^[A-Z]/.test(short)) {
    return short;
  }
  if (!short) {
    return undefined;
  }
  const singular = short.replace(/ies$/i, 'y').replace(/s$/i, '');
  return singular.charAt(0).toUpperCase() + singular.slice(1);
}

function loadCommandIndex(root: string): Map<string, { file: string; line: number }> {
  const dir = path.join(root, 'app', 'Console', 'Commands');
  const cached = commandCache.get(root);
  if (cached) {
    return cached;
  }
  const map = new Map<string, { file: string; line: number }>();
  scanPhpFiles(dir, 40, 20, (file, text, lines) => {
    for (let i = 0; i < lines.length; i++) {
      const sig = lines[i].match(
        /(?:\$signature|signature)\s*=\s*['"]([^'"]+)['"]/
      ) ?? lines[i].match(/->signature\(\s*['"]([^'"]+)['"]/);
      if (sig) {
        const name = sig[1].trim().split(/\s+/)[0];
        if (name && !map.has(name)) {
          map.set(name, { file, line: i });
        }
      }
    }
    void text;
  });
  commandCache.set(root, map);
  return map;
}

function loadMigrationIndex(
  root: string
): Map<string, { file: string; line: number }> {
  const cached = migrationCache.get(root);
  if (cached) {
    return cached;
  }
  const map = new Map<string, { file: string; line: number }>();
  const dir = path.join(root, 'database', 'migrations');
  scanPhpFiles(dir, 80, 8, (file, text, lines) => {
    const className = text.match(/\bclass\s+([A-Z][A-Za-z0-9_]*)/);
    if (className && !map.has(className[1])) {
      map.set(className[1], { file, line: 0 });
    }
    for (let i = 0; i < lines.length; i++) {
      const table = lines[i].match(
        /Schema::(?:create|table)\(\s*['"]([^'"]+)['"]/
      );
      if (table && !map.has(table[1])) {
        map.set(table[1], { file, line: i });
      }
    }
  });
  migrationCache.set(root, map);
  return map;
}

function findMigrationByFilename(
  root: string,
  needle: string
): { file: string; line: number } | undefined {
  const dir = path.join(root, 'database', 'migrations');
  if (!fs.existsSync(dir)) {
    return undefined;
  }
  const slug = needle
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/Table$/, '')
    .replace(/^Create/i, '')
    .toLowerCase();
  try {
    const files = fs.readdirSync(dir);
    for (const name of files) {
      if (name.endsWith('.php') && name.includes(slug)) {
        return { file: path.join(dir, name), line: 0 };
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

function loadEventListenIndex(root: string): Map<string, string[]> {
  const cached = listenCache.get(root);
  if (cached) {
    return cached;
  }
  const map = new Map<string, string[]>();
  const files = [
    path.join(root, 'app', 'Providers', 'EventServiceProvider.php'),
    path.join(root, 'app', 'Providers', 'AppServiceProvider.php'),
  ];
  for (const file of files) {
    indexListenFile(file, map);
  }
  scanPhpFiles(path.join(root, 'app', 'Listeners'), 40, 20, (_file, text) => {
    const events = [
      ...text.matchAll(/([A-Za-z_\\][A-Za-z0-9_\\]*)::class/g),
    ];
    const listenerClass = text.match(/\bclass\s+([A-Z][A-Za-z0-9_]*)/);
    if (!listenerClass) {
      return;
    }
    for (const ev of events) {
      const name = ev[1].replace(/^\\/, '');
      if (/Listener$/.test(name) || name === listenerClass[1]) {
        continue;
      }
      const list = map.get(name) ?? [];
      if (!list.includes(listenerClass[1])) {
        list.push(listenerClass[1]);
        map.set(name, list);
        const short = name.includes('\\') ? name.split('\\').pop()! : name;
        if (!map.has(short)) {
          map.set(short, list);
        }
      }
    }
  });
  listenCache.set(root, map);
  return map;
}

function indexListenFile(file: string, map: Map<string, string[]>): void {
  try {
    if (!fs.existsSync(file)) {
      return;
    }
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) {
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    const block = text.match(/\$listen\s*=\s*\[([\s\S]*?)\];/);
    const body = block?.[1] ?? text;
    const pairRe =
      /([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*=>\s*\[([\s\S]*?)\]/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(body)) !== null) {
      const event = m[1].replace(/^\\/, '');
      const listeners = [
        ...m[2].matchAll(/([A-Za-z_\\][A-Za-z0-9_\\]*)::class/g),
      ].map((x) => x[1].replace(/^\\/, ''));
      const list = map.get(event) ?? [];
      for (const l of listeners) {
        if (!list.includes(l)) {
          list.push(l);
        }
      }
      map.set(event, list);
      const short = event.includes('\\') ? event.split('\\').pop()! : event;
      if (!map.has(short)) {
        map.set(short, list);
      }
    }
  } catch {
    // ignore
  }
}

function scanPhpFiles(
  dir: string,
  maxFiles: number,
  maxDirs: number,
  visit: (file: string, text: string, lines: string[]) => void
): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const queue = [dir];
  let files = 0;
  let dirs = 0;
  while (queue.length && files < maxFiles && dirs < maxDirs) {
    const current = queue.shift()!;
    dirs++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= maxFiles) {
        return;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        queue.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        files++;
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_FILE_BYTES) {
            continue;
          }
          const text = fs.readFileSync(full, 'utf8');
          visit(full, text, text.split(/\r?\n/));
        } catch {
          // ignore
        }
      }
    }
  }
}

function loadGateIndex(root: string): Map<string, { file: string; line: number }> {
  const cached = gateCache.get(root);
  if (cached) {
    return cached;
  }
  const map = new Map<string, { file: string; line: number }>();
  const dirs = [
    path.join(root, 'app', 'Providers'),
    path.join(root, 'database', 'seeders'),
    path.join(root, 'database', 'seeds'),
  ];
  for (const dir of dirs) {
    scanPhpFiles(dir, 25, 12, (file, _text, lines) => {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const define = line.match(
          /Gate::define\s*\(\s*['"]([^'"]+)['"]/
        );
        if (define && !map.has(define[1])) {
          map.set(define[1], { file, line: i });
        }
        const permission = line.match(
          /Permission::(?:create|findOrCreate|firstOrCreate)\s*\(\s*(?:\[[^\]]*'name'\s*=>\s*)?['"]([^'"]+)['"]/
        );
        if (permission && !map.has(permission[1])) {
          map.set(permission[1], { file, line: i });
        }
      }
    });
  }
  gateCache.set(root, map);
  return map;
}

export function clearExtrasCaches(): void {
  commandCache.clear();
  migrationCache.clear();
  listenCache.clear();
  gateCache.clear();
}

/** Used so resolveModel fallback can try PSR-4 class files. */
export function resolveModelOrClass(
  root: string,
  className: string
): vscode.Location | undefined {
  return resolveModel(root, className) ?? resolveClass(root, className);
}
