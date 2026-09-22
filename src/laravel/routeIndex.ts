import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LruCache } from '../utils/cache';

export interface RouteHit {
  name: string;
  file: string;
  line: number; // 0-based
  /** Best-effort URI path, e.g. POST /admin/blog-posts */
  uri?: string;
}

interface RouteIndex {
  byName: Map<string, RouteHit>;
  signature: string;
}

const indexCache = new LruCache<RouteIndex>(10);

const MAX_ROUTE_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;

const RESOURCE_ACTIONS: Array<{
  action: string;
  methods: string;
  suffix: string;
  api: boolean;
}> = [
  { action: 'index', methods: 'GET', suffix: '', api: true },
  { action: 'create', methods: 'GET', suffix: '/create', api: false },
  { action: 'store', methods: 'POST', suffix: '', api: true },
  { action: 'show', methods: 'GET', suffix: '/{id}', api: true },
  { action: 'edit', methods: 'GET', suffix: '/{id}/edit', api: false },
  { action: 'update', methods: 'PUT|PATCH', suffix: '/{id}', api: true },
  { action: 'destroy', methods: 'DELETE', suffix: '/{id}', api: true },
];

/**
 * Build / reuse a lightweight index of named routes from routes/.
 * Handles ->name(), group name/prefix, and Route::resource / apiResource.
 * No artisan, no PHP — pure file scan with hard caps.
 */
export function findNamedRoute(root: string, routeName: string): vscode.Location | undefined {
  const hit = getRouteHit(root, routeName);
  if (!hit) {
    return undefined;
  }
  return new vscode.Location(
    vscode.Uri.file(hit.file),
    new vscode.Position(hit.line, 0)
  );
}

/** Reverse URI for hover, e.g. `POST /admin/blog-posts`. */
export function getRouteUri(root: string, routeName: string): string | undefined {
  return getRouteHit(root, routeName)?.uri;
}

function getRouteHit(root: string, routeName: string): RouteHit | undefined {
  return getRouteIndex(root).byName.get(routeName);
}

function getRouteIndex(root: string): RouteIndex {
  const routesDir = path.join(root, 'routes');
  const signature = buildSignature(routesDir);
  const cached = indexCache.get(root);
  if (cached && cached.signature === signature) {
    return cached;
  }

  const byName = new Map<string, RouteHit>();
  if (fs.existsSync(routesDir)) {
    const files = listPhpFiles(routesDir, MAX_ROUTE_FILES);
    for (const file of files) {
      indexFile(file, byName);
    }
  }

  const index: RouteIndex = { byName, signature };
  indexCache.set(root, index);
  return index;
}

function buildSignature(routesDir: string): string {
  try {
    if (!fs.existsSync(routesDir)) {
      return 'missing';
    }
    const files = listPhpFiles(routesDir, MAX_ROUTE_FILES);
    return files
      .map((f) => {
        try {
          return `${f}:${fs.statSync(f).mtimeMs}`;
        } catch {
          return f;
        }
      })
      .join('|');
  } catch {
    return 'error';
  }
}

function listPhpFiles(dir: string, maxFiles: number): string[] {
  const out: string[] = [];
  const queue = [dir];
  let dirs = 0;

  while (queue.length && out.length < maxFiles && dirs < 30) {
    const current = queue.shift()!;
    dirs++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) {
        break;
      }
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name.endsWith('.php')) {
        out.push(full);
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        queue.push(full);
      }
    }
  }
  return out;
}

interface PrefixFrame {
  name: string;
  uri: string;
}

function indexFile(file: string, byName: Map<string, RouteHit>): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_BYTES) {
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    const stack: PrefixFrame[] = [{ name: '', uri: '' }];
    let pendingName = '';
    let pendingUri = '';
    /** Last Route::get/post/… URI in current statement (survives function () { } bodies). */
    let lastRouteUri: string | undefined;
    let routeDepth = 0; // braces opened after a Route:: verb before its ->name

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const current = stack[stack.length - 1];

      const nameChain = [
        ...line.matchAll(/->name\(\s*['"]([^'"]+)['"]\s*\)/g),
        ...line.matchAll(/Route::name\(\s*['"]([^'"]+)['"]\s*\)/g),
      ];
      for (const m of nameChain) {
        if (m[1].endsWith('.') || /group\s*\(/.test(line)) {
          pendingName = m[1];
        }
      }
      const prefixChain = [
        ...line.matchAll(/->prefix\(\s*['"]([^'"]+)['"]\s*\)/g),
        ...line.matchAll(/Route::prefix\(\s*['"]([^'"]+)['"]\s*\)/g),
      ];
      for (const m of prefixChain) {
        pendingUri = m[1];
      }

      // Capture Route::verb('uri') even across multi-line closures
      const extracted = extractUriFromLine(line, current.uri);
      if (extracted) {
        lastRouteUri = extracted;
        routeDepth = 0;
      }

      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;

      if (opens > 0) {
        for (let o = 0; o < opens; o++) {
          // Group prefix push
          if (/group\s*\(/.test(line) || pendingName || pendingUri) {
            const name =
              pendingName !== ''
                ? joinName(current.name, pendingName)
                : current.name;
            const uri =
              pendingUri !== ''
                ? joinUri(current.uri, pendingUri)
                : current.uri;
            stack.push({ name, uri });
            pendingName = '';
            pendingUri = '';
          } else if (lastRouteUri) {
            routeDepth++;
          }
        }
      }

      indexLine(line, i, file, stack[stack.length - 1], byName, lastRouteUri);

      if (closes > 0) {
        for (let c = 0; c < closes; c++) {
          if (routeDepth > 0) {
            routeDepth--;
          } else if (stack.length > 1) {
            stack.pop();
          }
        }
      }

      if (/;/.test(line) && routeDepth === 0) {
        lastRouteUri = undefined;
      }
    }
  } catch {
    // ignore
  }
}

function indexLine(
  line: string,
  lineNo: number,
  file: string,
  frame: PrefixFrame,
  byName: Map<string, RouteHit>,
  lastRouteUri?: string
): void {
  // Route::resource / apiResource
  const resourceRe =
    /Route::(apiResource|resource)\(\s*['"]([^'"]+)['"]/g;
  let rm: RegExpExecArray | null;
  while ((rm = resourceRe.exec(line)) !== null) {
    const isApi = rm[1] === 'apiResource';
    const resource = rm[2];
    let nameBase = joinName(frame.name, resource.replace(/\//g, '.'));
    const uriBase = joinUri(frame.uri, resource);

    const namesStr = line.match(/->names\(\s*['"]([^'"]+)['"]\s*\)/);
    if (namesStr) {
      nameBase = namesStr[1].endsWith('.')
        ? namesStr[1].slice(0, -1)
        : namesStr[1];
    }

    if (!namesStr) {
      const nameStr = line.match(/->name\(\s*['"]([^'"]+)['"]\s*\)/);
      if (nameStr && !nameStr[1].endsWith('.')) {
        nameBase = nameStr[1];
      }
    }

    for (const action of RESOURCE_ACTIONS) {
      if (isApi && !action.api) {
        continue;
      }
      register(
        byName,
        `${nameBase}.${action.action}`,
        file,
        lineNo,
        `${action.methods} ${uriBase}${action.suffix}`
      );
    }
  }

  // Explicit ->name('foo')
  const nameRe = /->name\(\s*['"]([^'"]+)['"]\s*\)/g;
  let nm: RegExpExecArray | null;
  while ((nm = nameRe.exec(line)) !== null) {
    const raw = nm[1];
    if (raw.endsWith('.')) {
      continue;
    }
    if (/Route::(apiResource|resource)\(/.test(line)) {
      continue;
    }
    const fullName = joinName(frame.name, raw);
    const uri =
      extractUriFromLine(line, frame.uri) ?? lastRouteUri;
    register(byName, fullName, file, lineNo, uri);
  }
}

function extractUriFromLine(line: string, uriPrefix: string): string | undefined {
  const m = line.match(
    /Route::(get|post|put|patch|delete|options|any|match|view|redirect|permanentRedirect)\(\s*(?:\[[^\]]*\]\s*,\s*)?['"]([^'"]*)['"]/i
  );
  if (!m) {
    return undefined;
  }
  const method = m[1].toUpperCase();
  const uri = joinUri(uriPrefix, m[2]);
  if (method === 'MATCH') {
    return `MATCH ${uri}`;
  }
  if (method === 'VIEW' || method === 'REDIRECT' || method === 'PERMANENTREDIRECT') {
    return `GET ${uri}`;
  }
  if (method === 'ANY') {
    return `ANY ${uri}`;
  }
  return `${method} ${uri}`;
}

function register(
  byName: Map<string, RouteHit>,
  name: string,
  file: string,
  line: number,
  uri?: string
): void {
  if (!name) {
    return;
  }
  const existing = byName.get(name);
  // Prefer entry that has a URI (upgrade if we found path later)
  if (existing) {
    if (!existing.uri && uri) {
      existing.uri = uri;
      existing.line = line;
      existing.file = file;
    }
    return;
  }
  byName.set(name, { name, file, line, uri });
}

function joinName(prefix: string, name: string): string {
  if (!prefix) {
    return name;
  }
  if (name.startsWith(prefix)) {
    return name;
  }
  const p = prefix.endsWith('.') ? prefix : `${prefix}.`;
  return `${p}${name}`;
}

function joinUri(prefix: string, segment: string): string {
  const a = prefix.replace(/^\/+|\/+$/g, '');
  const b = segment.replace(/^\/+|\/+$/g, '');
  if (!a) {
    return b ? `/${b}` : '/';
  }
  if (!b) {
    return `/${a}`;
  }
  return `/${a}/${b}`;
}

export function clearRouteIndexCache(): void {
  indexCache.clear();
}
