import * as fs from 'fs';
import * as vscode from 'vscode';
import { applyUseMap, parseUseMapFromText } from '../utils/phpHelpers';
import {
  ConventionKind,
  findMethodPosition,
  resolveByConvention,
  resolveClass,
} from './classResolver';
import { resolveModel } from './modelResolver';

const MAX_FILE_BYTES = 128 * 1024;
const MAX_BODY_LINES = 100;
const MAX_EXTRAS = 6;

const SKIP_PROPS = new Set([
  'request',
  'user',
  'app',
  'config',
  'log',
  'validator',
  'gate',
  'mail',
  'cache',
  'session',
  'cookie',
  'files',
  'redirect',
  'view',
  'auth',
  'response',
  'input',
  'output',
]);

/**
 * One hop from a method body: $this->repo->foo(), User::create(), app(X::class).
 * Used so Service → Repository → Model shows as extra definitions.
 */
export function resolveCallChain(
  root: string,
  ownerFile: string,
  methodName: string
): vscode.Location[] {
  const text = readCapped(ownerFile);
  if (!text) {
    return [];
  }
  const body = extractMethodBody(text, methodName);
  if (!body) {
    return [];
  }

  const uses = parseUseMapFromText(text);
  const props = collectPropertyTypes(text);
  const owner = text.match(/\bclass\s+([A-Z][A-Za-z0-9_]*)/)?.[1];
  const seen = new Set<string>();
  const out: vscode.Location[] = [];

  const add = (className: string, member?: string): void => {
    if (out.length >= MAX_EXTRAS) {
      return;
    }
    const fqcn = applyUseMap(uses, className);
    const short = fqcn.includes('\\') ? fqcn.split('\\').pop()! : fqcn;
    if (!short || short === owner) {
      return;
    }
    const key = `${fqcn}|${member ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const loc = resolveNamed(root, fqcn, member);
    if (!loc) {
      return;
    }
    if (loc.uri.fsPath === ownerFile && !member) {
      return;
    }
    out.push(loc);
  };

  let m: RegExpExecArray | null;
  const propCall = /\$this\s*->\s*([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  while ((m = propCall.exec(body)) !== null) {
    if (SKIP_PROPS.has(m[1])) {
      continue;
    }
    const type = props.get(m[1]) ?? guessClassFromProp(m[1]);
    if (type) {
      add(type, m[2]);
    }
  }

  const staticCall =
    /\b([A-Z][A-Za-z0-9_\\]*)\s*::\s*(create|query|find|findOrFail|first|firstOrFail|updateOrCreate|factory|all|make|dispatch|dispatchSync)\s*\(/g;
  while ((m = staticCall.exec(body)) !== null) {
    add(m[1], undefined);
  }

  const newCall = /\bnew\s+\\?([A-Z][A-Za-z0-9_\\]*)\s*\(/g;
  while ((m = newCall.exec(body)) !== null) {
    if (/^(DateTime|Carbon|Collection|Request|Exception)/.test(m[1])) {
      continue;
    }
    add(m[1], undefined);
  }

  const appCall =
    /(?:app|resolve)\(\s*\\?([A-Z][A-Za-z0-9_\\]*)::class\s*\)(?:\s*->\s*([A-Za-z_][A-Za-z0-9_]*))?/g;
  while ((m = appCall.exec(body)) !== null) {
    add(m[1], m[2]);
  }

  return out;
}

function resolveNamed(
  root: string,
  className: string,
  member?: string
): vscode.Location | undefined {
  const short = className.includes('\\')
    ? className.split('\\').pop()!
    : className;
  const kind = conventionKindFor(short);
  if (kind) {
    const loc = resolveByConvention(root, kind, className) ?? resolveClass(root, className);
    if (!loc) {
      return undefined;
    }
    if (member) {
      return new vscode.Location(
        loc.uri,
        findMethodPosition(loc.uri.fsPath, member)
      );
    }
    return loc;
  }
  if (member) {
    return resolveClass(root, className, member);
  }
  return resolveModel(root, className) ?? resolveClass(root, className);
}

function conventionKindFor(short: string): ConventionKind | undefined {
  if (/Repository$/.test(short)) {
    return 'repository';
  }
  if (/Interface$|Contract$/.test(short)) {
    return 'contract';
  }
  if (/Notification$/.test(short)) {
    return 'notification';
  }
  if (/Mail$|Mailable$/.test(short)) {
    return 'mail';
  }
  if (/Job$/.test(short)) {
    return 'job';
  }
  return undefined;
}

function collectPropertyTypes(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const propRe =
    /(?:private|protected|public)(?:\s+readonly)?\s+(\\?[A-Z][A-Za-z0-9_\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(text)) !== null) {
    map.set(m[2], m[1].replace(/^\\/, ''));
  }
  const ctor = text.match(/function\s+__construct\s*\(([\s\S]*?)\)\s*\{/);
  if (ctor) {
    const paramRe = /(\\?[A-Z][A-Za-z0-9_\\]*)\s+\$([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((m = paramRe.exec(ctor[1])) !== null) {
      if (!map.has(m[2])) {
        map.set(m[2], m[1].replace(/^\\/, ''));
      }
    }
  }
  return map;
}

function guessClassFromProp(prop: string): string | undefined {
  if (!/^[a-z]/.test(prop) || SKIP_PROPS.has(prop)) {
    return undefined;
  }
  const studly = prop.charAt(0).toUpperCase() + prop.slice(1);
  if (/Repository$|Service$|Factory$|Interface$|Contract$/.test(studly)) {
    return studly;
  }
  return undefined;
}

function extractMethodBody(text: string, method: string): string | undefined {
  const re = new RegExp(
    `function\\s+${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`
  );
  const start = text.search(re);
  if (start < 0) {
    return undefined;
  }
  const brace = text.indexOf('{', start);
  if (brace < 0 || brace - start > 400) {
    return undefined;
  }
  let depth = 0;
  let end = brace;
  const limit = Math.min(text.length, brace + 16 * 1024);
  for (let i = brace; i < limit; i++) {
    const ch = text[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = text.slice(brace + 1, end);
  const lines = body.split(/\r?\n/);
  return lines.length > MAX_BODY_LINES
    ? lines.slice(0, MAX_BODY_LINES).join('\n')
    : body;
}

function readCapped(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      return undefined;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}
