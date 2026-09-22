import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveClass, findMethodPosition } from './classResolver';
import { resolveModel, expandModelName } from './modelResolver';
import { resolvePsr4Path } from '../laravel/psr4';
import { findExistingFile } from '../utils/fileFinder';

const RELATION_METHODS =
  'belongsTo|belongsToMany|hasOne|hasMany|hasManyThrough|hasOneThrough|morphTo|morphOne|morphMany|morphToMany|morphedByMany|hasOneOfMany|hasManyThrough';

/**
 * $user->posts → related Model (Post), by reading posts() relation body.
 * Lightweight: only owner file + related path exists check. No PHP.
 */
export function resolveRelation(
  root: string,
  ownerClass: string,
  relationName: string
): vscode.Location | undefined {
  for (const owner of expandModelName(ownerClass)) {
    const ownerLoc = resolveClass(root, owner) ?? resolveModel(root, owner);
    if (!ownerLoc) {
      continue;
    }

    const related = extractRelatedClass(ownerLoc.uri.fsPath, relationName);
    if (!related) {
      continue;
    }

    const hit =
      resolveModel(root, related) ??
      resolveClass(root, related) ??
      (() => {
        const uri = findExistingFile(resolvePsr4Path(root, related));
        return uri
          ? new vscode.Location(uri, new vscode.Position(0, 0))
          : undefined;
      })();
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * If relation target not found, jump to relation / method on owner.
 */
export function resolveRelationOrMethod(
  root: string,
  ownerClass: string,
  relationName: string
): vscode.Location | undefined {
  const related = resolveRelation(root, ownerClass, relationName);
  if (related) {
    return related;
  }
  for (const owner of expandModelName(ownerClass)) {
    const hit =
      resolveClass(root, owner, relationName) ?? resolveModel(root, owner);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function extractRelatedClass(
  ownerFile: string,
  relationName: string
): string | undefined {
  try {
    const stat = fs.statSync(ownerFile);
    if (stat.size > 256 * 1024) {
      return undefined;
    }
    const text = fs.readFileSync(ownerFile, 'utf8');
    const methodPos = findMethodPosition(ownerFile, relationName);
    const lines = text.split(/\r?\n/);
    const start = methodPos.line;
    // Read small window of method body only
    const end = Math.min(lines.length, start + 25);
    const body = lines.slice(start, end).join('\n');

    // return $this->hasMany(Post::class
    // return $this->belongsTo(\App\Models\Post::class)
    const re = new RegExp(
      `\\$this\\s*->\\s*(?:${RELATION_METHODS})\\s*\\(\\s*([\\\\A-Za-z_][\\\\A-Za-z0-9_]*)::class`
    );
    const m = body.match(re);
    if (m) {
      return m[1].replace(/^\\/, '');
    }

    // morphTo has no class — skip
    // return $this->hasMany('App\\Models\\Post')
    const strRe = new RegExp(
      `\\$this\\s*->\\s*(?:${RELATION_METHODS})\\s*\\(\\s*['"]([\\\\A-Za-z_][\\\\A-Za-z0-9_\\\\]*)['"]`
    );
    const m2 = body.match(strRe);
    if (m2) {
      return m2[1].replace(/^\\/, '');
    }
  } catch {
    // ignore
  }
  return undefined;
}
