import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolvePsr4Path } from '../laravel/psr4';
import { findExistingFile, findFileUnder } from '../utils/fileFinder';
import { LruCache } from '../utils/cache';

const aliasCache = new LruCache<Map<string, string>>(10);
const methodScanCache = new LruCache<vscode.Location | null>(100);

/** Resolve any PHP class via PSR-4 + convention folders. */
export function resolveClass(
  root: string,
  className: string,
  member?: string
): vscode.Location | undefined {
  const uri = findExistingFile(resolvePsr4Path(root, className));
  if (!uri) {
    // Last resort: shallow find under app/ by filename only
    const short = className.includes('\\')
      ? className.split('\\').pop()!
      : className;
    const found = findFileUnder(path.join(root, 'app'), `${short}.php`, {
      maxDirs: 50,
      maxFiles: 250,
      maxDepth: 5,
    });
    if (!found) {
      // Still try locating the method by name under Models (traits / odd names)
      if (member) {
        return findMethodInApp(root, member);
      }
      return undefined;
    }
    if (member && !methodExistsAt(found.fsPath, member)) {
      return (
        findMethodOnUsedTraits(root, found.fsPath, member) ??
        findMethodInApp(root, member) ??
        locationAtMember(found, member)
      );
    }
    return locationAtMember(found, member);
  }
  if (member && !methodExistsAt(uri.fsPath, member)) {
    return (
      findMethodOnUsedTraits(root, uri.fsPath, member) ??
      findMethodInApp(root, member) ??
      locationAtMember(uri, member)
    );
  }
  return locationAtMember(uri, member);
}

/**
 * Capped scan: find `function methodName(` under app/Models then app/.
 * Used when owner class guess fails or method is on a trait.
 */
export function findMethodInApp(
  root: string,
  method: string
): vscode.Location | undefined {
  const key = `${root}|fn|${method}`;
  const cached = methodScanCache.get(key);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const bases = [
    path.join(root, 'app', 'Services'),
    path.join(root, 'app', 'Repositories'),
    path.join(root, 'app', 'Models'),
    path.join(root, 'app'),
  ];
  for (const base of bases) {
    const hit = scanForMethod(base, method, {
      maxDirs: 40,
      maxFiles: 120,
      maxDepth: 4,
    });
    if (hit) {
      methodScanCache.set(key, hit);
      return hit;
    }
  }
  methodScanCache.set(key, null);
  return undefined;
}

function scanForMethod(
  baseDir: string,
  method: string,
  options: { maxDirs: number; maxFiles: number; maxDepth: number }
): vscode.Location | undefined {
  if (!fs.existsSync(baseDir)) {
    return undefined;
  }
  const re = new RegExp(
    `function\\s+${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`
  );
  const queue: Array<{ dir: string; depth: number }> = [{ dir: baseDir, depth: 0 }];
  let dirsSeen = 0;
  let filesSeen = 0;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || dirsSeen >= options.maxDirs || filesSeen >= options.maxFiles) {
      break;
    }
    dirsSeen++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (filesSeen >= options.maxFiles) {
        break;
      }
      const full = path.join(item.dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.php')) {
        filesSeen++;
        try {
          const stat = fs.statSync(full);
          if (stat.size > 256 * 1024) {
            continue;
          }
          const text = fs.readFileSync(full, 'utf8');
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              return new vscode.Location(
                vscode.Uri.file(full),
                new vscode.Position(i, Math.max(0, lines[i].indexOf(method)))
              );
            }
          }
        } catch {
          // ignore
        }
      } else if (entry.isDirectory() && item.depth < options.maxDepth) {
        if (
          entry.name === 'vendor' ||
          entry.name === 'node_modules' ||
          entry.name.startsWith('.')
        ) {
          continue;
        }
        queue.push({ dir: full, depth: item.depth + 1 });
      }
    }
  }
  return undefined;
}

function methodExistsAt(filePath: string, method: string): boolean {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const re = new RegExp(
      `function\\s+${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`
    );
    return re.test(text);
  } catch {
    return false;
  }
}

function findMethodOnUsedTraits(
  root: string,
  ownerFile: string,
  method: string
): vscode.Location | undefined {
  try {
    const text = fs.readFileSync(ownerFile, 'utf8');
    // use SomeTrait; / use Foo, Bar;
    const useBlock = text.match(/\buse\s+([^;]+);/g) ?? [];
    for (const stmt of useBlock) {
      if (/^use\s+[A-Za-z_\\]+\\/.test(stmt.trim()) && stmt.includes('{')) {
        continue; // group imports of classes at top — still ok to try
      }
      // Inside class body: `use HandlesLeads;` (no backslash often = trait)
      const traits = stmt
        .replace(/^\s*use\s+/, '')
        .replace(/;$/, '')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter((s) => s && !s.includes('('));
      for (const t of traits) {
        // Skip obvious FQCN imports of non-traits at file top (App\Models\X)
        if (/^App\\/.test(t) && !/Trait/.test(t)) {
          continue;
        }
        const loc = resolveTrait(root, t);
        if (loc && methodExistsAt(loc.uri.fsPath, method)) {
          return locationAtMember(loc.uri, method);
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function resolveTrait(root: string, name: string): vscode.Location | undefined {
  const short = name.includes('\\') ? name.split('\\').pop()! : name;
  const candidates = [
    ...resolvePsr4Path(root, name),
    path.join(root, 'app', 'Traits', `${short}.php`),
    path.join(root, 'app', 'Http', 'Traits', `${short}.php`),
    path.join(root, 'app', 'Support', 'Traits', `${short}.php`),
  ];
  const uri = findExistingFile(candidates);
  if (uri) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
  const found = findFileUnder(path.join(root, 'app'), `${short}.php`, {
    maxDirs: 40,
    maxFiles: 200,
    maxDepth: 5,
  });
  return found ? new vscode.Location(found, new vscode.Position(0, 0)) : undefined;
}

export type ConventionKind =
  | 'middleware'
  | 'job'
  | 'event'
  | 'listener'
  | 'policy'
  | 'request'
  | 'repository'
  | 'contract'
  | 'exception'
  | 'command'
  | 'notification'
  | 'mail'
  | 'provider'
  | 'seeder'
  | 'factory';

export function resolveByConvention(
  root: string,
  kind: ConventionKind,
  name: string
): vscode.Location | undefined {
  // Middleware may be an alias string like 'auth' or 'permission:users.create'
  if (kind === 'middleware' && !name.includes('\\') && !/[A-Z]/.test(name[0] || '')) {
    const alias = name.split(':')[0];
    const aliased = resolveMiddlewareAlias(root, alias);
    if (aliased) {
      return aliased;
    }
  }

  const short = name.includes('\\') ? name.split('\\').pop()! : name;
  const folders: Record<ConventionKind, string[]> = {
    middleware: [
      path.join(root, 'app', 'Http', 'Middleware'),
      path.join(root, 'app', 'Middleware'),
    ],
    job: [path.join(root, 'app', 'Jobs')],
    event: [path.join(root, 'app', 'Events')],
    listener: [path.join(root, 'app', 'Listeners')],
    policy: [path.join(root, 'app', 'Policies')],
    request: [
      path.join(root, 'app', 'Http', 'Requests'),
      path.join(root, 'app', 'Requests'),
    ],
    repository: [
      path.join(root, 'app', 'Repositories'),
      path.join(root, 'app', 'Repository'),
    ],
    contract: [
      path.join(root, 'app', 'Contracts'),
      path.join(root, 'app', 'Interfaces'),
    ],
    exception: [path.join(root, 'app', 'Exceptions')],
    command: [path.join(root, 'app', 'Console', 'Commands')],
    notification: [path.join(root, 'app', 'Notifications')],
    mail: [path.join(root, 'app', 'Mail'), path.join(root, 'app', 'Mails')],
    provider: [path.join(root, 'app', 'Providers')],
    seeder: [
      path.join(root, 'database', 'seeders'),
      path.join(root, 'database', 'seeds'),
    ],
    factory: [path.join(root, 'database', 'factories')],
  };

  const candidates = [
    ...resolvePsr4Path(root, name),
    ...folders[kind].map((dir) => path.join(dir, `${short}.php`)),
  ];

  const uri = findExistingFile(candidates);
  if (uri) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }

  for (const dir of folders[kind]) {
    const found = findFileUnder(dir, `${short}.php`, {
      maxDirs: 30,
      maxFiles: 120,
      maxDepth: 4,
    });
    if (found) {
      return new vscode.Location(found, new vscode.Position(0, 0));
    }
  }
  return undefined;
}

/**
 * Read route middleware aliases from bootstrap/app.php or Http/Kernel.php (capped).
 */
function resolveMiddlewareAlias(
  root: string,
  alias: string
): vscode.Location | undefined {
  const map = loadMiddlewareAliases(root);
  const className = map.get(alias);
  if (!className) {
    return undefined;
  }
  return resolveClass(root, className);
}

function loadMiddlewareAliases(root: string): Map<string, string> {
  const cached = aliasCache.get(root);
  if (cached) {
    return cached;
  }

  const map = new Map<string, string>();
  const files = [
    path.join(root, 'app', 'Http', 'Kernel.php'),
    path.join(root, 'bootstrap', 'app.php'),
  ];

  for (const file of files) {
    try {
      if (!fs.existsSync(file)) {
        continue;
      }
      const stat = fs.statSync(file);
      if (stat.size > 128 * 1024) {
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      // 'auth' => \App\Http\Middleware\Authenticate::class
      const re =
        /['"]([a-zA-Z0-9._:-]+)['"]\s*=>\s*([\\A-Za-z0-9_]+)::class/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (!map.has(m[1])) {
          map.set(m[1], m[2].replace(/^\\/, ''));
        }
      }
    } catch {
      // ignore
    }
  }

  aliasCache.set(root, map);
  return map;
}

function locationAtMember(
  uri: vscode.Uri,
  member?: string
): vscode.Location {
  if (!member) {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
  const pos = findMethodPosition(uri.fsPath, member);
  return new vscode.Location(uri, pos);
}

export function findMethodPosition(
  filePath: string,
  method: string
): vscode.Position {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 256 * 1024) {
      return new vscode.Position(0, 0);
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    const re = new RegExp(
      `function\\s+${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`
    );
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        return new vscode.Position(i, Math.max(0, lines[i].indexOf(method)));
      }
    }
  } catch {
    // ignore
  }
  return new vscode.Position(0, 0);
}

export function clearConventionCaches(): void {
  aliasCache.clear();
  methodScanCache.clear();
}
