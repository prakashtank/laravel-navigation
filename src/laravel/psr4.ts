import * as fs from 'fs';
import * as path from 'path';
import { LruCache } from '../utils/cache';

interface Psr4Map {
  prefixes: Array<{ prefix: string; dir: string }>;
  signature: string;
}

const composerCache = new LruCache<Psr4Map>(20);

/**
 * Resolve a PHP class/trait FQCN (or short name) via:
 * - project composer.json PSR-4
 * - vendor/composer/autoload_psr4.php (Illuminate, etc.)
 * Never runs Composer CLI / PHP.
 */
export function resolvePsr4Path(root: string, className: string): string[] {
  const map = loadPsr4(root);
  const fqcn = className.replace(/^\\/, '');
  const candidates: string[] = [];

  for (const { prefix, dir } of map.prefixes) {
    if (fqcn.startsWith(prefix)) {
      const relative = fqcn.slice(prefix.length).replace(/\\/g, path.sep);
      candidates.push(path.join(root, dir, `${relative}.php`));
    }
  }

  const short = fqcn.includes('\\') ? fqcn.split('\\').pop()! : fqcn;
  if (!fqcn.includes('\\') || candidates.length === 0) {
    candidates.push(
      path.join(root, 'app', `${short}.php`),
      path.join(root, 'app', 'Models', `${short}.php`),
      path.join(root, 'app', 'Services', `${short}.php`),
      path.join(root, 'app', 'Repositories', `${short}.php`),
      path.join(root, 'app', 'Contracts', `${short}.php`),
      path.join(root, 'app', 'Interfaces', `${short}.php`),
      path.join(root, 'app', 'Exceptions', `${short}.php`),
      path.join(root, 'app', 'Notifications', `${short}.php`),
      path.join(root, 'app', 'Mail', `${short}.php`),
      path.join(root, 'app', 'Console', 'Commands', `${short}.php`),
      path.join(root, 'app', 'Providers', `${short}.php`),
      path.join(root, 'app', 'Actions', `${short}.php`),
      path.join(root, 'database', 'seeders', `${short}.php`),
      path.join(root, 'database', 'factories', `${short}.php`),
      path.join(root, 'app', 'Http', 'Controllers', `${short}.php`),
      path.join(root, 'app', 'Http', 'Middleware', `${short}.php`),
      path.join(root, 'app', 'Http', 'Requests', `${short}.php`),
      path.join(root, 'app', 'Jobs', `${short}.php`),
      path.join(root, 'app', 'Events', `${short}.php`),
      path.join(root, 'app', 'Listeners', `${short}.php`),
      path.join(root, 'app', 'Policies', `${short}.php`),
      path.join(root, 'app', 'Traits', `${short}.php`),
      path.join(root, 'app', 'Support', `${short}.php`)
    );
  }

  return unique(candidates);
}

function loadPsr4(root: string): Psr4Map {
  const signature = buildSignature(root);
  const cached = composerCache.get(root);
  if (cached && cached.signature === signature) {
    return cached;
  }

  const prefixes: Array<{ prefix: string; dir: string }> = [];

  // 1) Project composer.json
  loadProjectComposer(root, prefixes);

  // 2) Vendor autoload (Illuminate, packages)
  loadVendorAutoloadPsr4(root, prefixes);

  // 3) Fast Laravel fallback if vendor present but parse missed
  const illuminateRel = 'vendor/laravel/framework/src/Illuminate';
  if (
    fs.existsSync(path.join(root, illuminateRel)) &&
    !prefixes.some((p) => p.prefix === 'Illuminate\\')
  ) {
    prefixes.push({ prefix: 'Illuminate\\', dir: illuminateRel });
  }

  if (prefixes.length === 0) {
    prefixes.push(...defaultPrefixes());
  }

  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  const result = { prefixes, signature };
  composerCache.set(root, result);
  return result;
}

function buildSignature(root: string): string {
  const files = [
    path.join(root, 'composer.json'),
    path.join(root, 'vendor/composer/autoload_psr4.php'),
  ];
  return files
    .map((f) => {
      try {
        return `${f}:${fs.statSync(f).mtimeMs}`;
      } catch {
        return `${f}:0`;
      }
    })
    .join('|');
}

function loadProjectComposer(
  root: string,
  prefixes: Array<{ prefix: string; dir: string }>
): void {
  const composerPath = path.join(root, 'composer.json');
  try {
    if (!fs.existsSync(composerPath)) {
      return;
    }
    const raw = fs.readFileSync(composerPath, 'utf8');
    if (raw.length > 200_000) {
      return;
    }
    const json = JSON.parse(raw) as {
      autoload?: { 'psr-4'?: Record<string, string | string[]> };
      'autoload-dev'?: { 'psr-4'?: Record<string, string | string[]> };
    };
    collectPsr4(json.autoload?.['psr-4'], prefixes);
    collectPsr4(json['autoload-dev']?.['psr-4'], prefixes);
  } catch {
    // ignore
  }
}

/**
 * Parse vendor/composer/autoload_psr4.php without executing PHP.
 * Handles: 'Illuminate\\' => array($vendorDir . '/laravel/framework/src/Illuminate')
 *          'App\\' => array($baseDir . '/app')
 */
function loadVendorAutoloadPsr4(
  root: string,
  prefixes: Array<{ prefix: string; dir: string }>
): void {
  const file = path.join(root, 'vendor/composer/autoload_psr4.php');
  try {
    if (!fs.existsSync(file)) {
      return;
    }
    const stat = fs.statSync(file);
    if (stat.size > 512 * 1024) {
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    // 'Prefix\\' => array($vendorDir . '/path/to')
    const vendorRe =
      /'((?:\\\\|[^'])+)'\s*=>\s*array\s*\(\s*\$vendorDir\s*\.\s*'([^']+)'/g;
    // 'Prefix\\' => array($baseDir . '/path')
    const baseRe =
      /'((?:\\\\|[^'])+)'\s*=>\s*array\s*\(\s*\$baseDir\s*\.\s*'([^']+)'/g;

    let m: RegExpExecArray | null;
    while ((m = vendorRe.exec(text)) !== null) {
      const prefix = normalizePrefix(m[1]);
      const rel = ('vendor' + m[2]).replace(/\\/g, '/').replace(/\/+/g, '/');
      if (!prefixes.some((p) => p.prefix === prefix && p.dir === rel)) {
        prefixes.push({ prefix, dir: rel.replace(/^\//, '') });
      }
    }
    while ((m = baseRe.exec(text)) !== null) {
      const prefix = normalizePrefix(m[1]);
      const rel = m[2].replace(/^\//, '').replace(/\\/g, '/');
      if (!prefixes.some((p) => p.prefix === prefix && p.dir === rel)) {
        prefixes.push({ prefix, dir: rel });
      }
    }
  } catch {
    // ignore
  }
}

function normalizePrefix(raw: string): string {
  // In PHP file strings, namespaces are written as Illuminate\\
  return raw.replace(/\\\\/g, '\\').replace(/\\+$/, '\\');
}

function collectPsr4(
  map: Record<string, string | string[]> | undefined,
  out: Array<{ prefix: string; dir: string }>
): void {
  if (!map) {
    return;
  }
  for (const [prefix, dir] of Object.entries(map)) {
    const dirs = Array.isArray(dir) ? dir : [dir];
    for (const d of dirs) {
      out.push({
        prefix: prefix.replace(/\\+$/, '\\'),
        dir: d.replace(/\/$/, ''),
      });
    }
  }
}

function defaultPrefixes(): Array<{ prefix: string; dir: string }> {
  return [
    { prefix: 'App\\', dir: 'app' },
    { prefix: 'Database\\', dir: 'database' },
  ];
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

export function clearPsr4Cache(): void {
  composerCache.clear();
}
