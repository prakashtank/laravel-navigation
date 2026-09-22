import * as vscode from 'vscode';
import {
  getCurrentLine,
  getLineContext,
  getStringLiteralAtPosition,
  getWordAtPosition,
  resolveUseImport,
} from '../utils/phpHelpers';

export type SymbolKind =
  | 'view'
  | 'config'
  | 'env'
  | 'asset'
  | 'vite'
  | 'lang'
  | 'controller'
  | 'model'
  | 'route'
  | 'class'
  | 'trait'
  | 'middleware'
  | 'job'
  | 'event'
  | 'listener'
  | 'policy'
  | 'request'
  | 'localMethod'
  | 'instanceMethod'
  | 'relation';

export interface DetectedSymbol {
  kind: SymbolKind;
  value: string;
  /** Controller / class method name when known */
  member?: string;
}

/**
 * Detect Laravel / PHP symbol under cursor.
 * More specific string contexts first, then suffix conventions, then generic class.
 */
export function detectSymbol(
  document: vscode.TextDocument,
  position: vscode.Position
): DetectedSymbol | undefined {
  const line = getCurrentLine(document, position);
  const ctx = getLineContext(document, position, 1);
  const stringLit = getStringLiteralAtPosition(document, position);
  const word = getWordAtPosition(document, position);

  // --- View / Blade ---
  if (stringLit !== undefined && isViewContext(line, stringLit)) {
    return { kind: 'view', value: stringLit };
  }

  // --- Config ---
  if (stringLit !== undefined && isConfigContext(line, stringLit)) {
    return { kind: 'config', value: stringLit };
  }

  // --- env('KEY') ---
  if (stringLit !== undefined && isEnvContext(line, stringLit)) {
    return { kind: 'env', value: stringLit };
  }

  // --- asset('...') ---
  if (stringLit !== undefined && isAssetContext(line, stringLit)) {
    return { kind: 'asset', value: stringLit };
  }

  // --- @vite('...') / Vite:: ---
  if (stringLit !== undefined && isViteContext(ctx, stringLit)) {
    return { kind: 'vite', value: stringLit };
  }

  // --- __('...') / trans() / @lang() ---
  if (stringLit !== undefined && isLangContext(ctx, stringLit)) {
    return { kind: 'lang', value: stringLit };
  }

  // --- Named route (route() / reverse routing) ---
  if (stringLit !== undefined && isRouteContext(ctx, stringLit)) {
    return { kind: 'route', value: stringLit };
  }

  // --- Middleware alias string ---
  if (stringLit !== undefined && isMiddlewareStringContext(line, stringLit)) {
    return { kind: 'middleware', value: stringLit };
  }

  // --- Controller@method string ---
  if (stringLit !== undefined && isControllerString(stringLit)) {
    const [ctrl, method] = stringLit.split('@');
    return { kind: 'controller', value: ctrl, member: method };
  }

  // --- [Controller::class, 'method'] — cursor on method string ---
  if (stringLit !== undefined && isControllerActionMethod(ctx, stringLit)) {
    const ctrl = extractControllerFromActionArray(ctx);
    if (ctrl) {
      return { kind: 'controller', value: stripClassSuffix(ctrl), member: stringLit };
    }
  }

  // --- $this->filters() / self::foo() / static::bar() ---
  if (word && isLocalMethodCall(line, word)) {
    return { kind: 'localMethod', value: document.uri.fsPath, member: word };
  }

  // --- $request->keywordsList() / $user->posts / $contact?->foo() ---
  if (word) {
    const varName = extractInstanceVar(line, word);
    if (varName && varName !== 'this') {
      const typeName =
        inferVariableType(document, position, varName) ??
        guessModelFromVar(varName);
      if (typeName) {
        const fqcn = resolveUseImport(document, typeName);
        const calledAsMethod = new RegExp(
          `\\??->\\s*${escapeRegExp(word)}\\s*\\(`
        ).test(line);
        if (
          !calledAsMethod &&
          isLikelyEloquentOwner(fqcn, shortName(fqcn))
        ) {
          return { kind: 'relation', value: fqcn, member: word };
        }
        return { kind: 'instanceMethod', value: fqcn, member: word };
      }
      // Last resort: still try resolving the method by name alone
      return { kind: 'instanceMethod', value: '_', member: word };
    }
  }

  if (word) {
    const cleanShort = stripClassSuffix(word);
    const short = shortName(cleanShort);
    // Expand via use App\Services\MetaWebhookService;
    const clean = resolveUseImport(document, cleanShort);

    // Controller class (+ optional method from same line array)
    if (/Controller$/.test(short)) {
      const member = extractMethodBesideController(ctx, short);
      return { kind: 'controller', value: clean, member };
    }

    // Convention suffixes
    if (/Middleware$/.test(short) || clean.includes('\\Middleware\\')) {
      return { kind: 'middleware', value: clean };
    }
    if (/Job$/.test(short) || clean.includes('\\Jobs\\')) {
      return { kind: 'job', value: clean };
    }
    if (/Listener$/.test(short) || clean.includes('\\Listeners\\')) {
      return { kind: 'listener', value: clean };
    }
    if (/Policy$/.test(short) || clean.includes('\\Policies\\')) {
      return { kind: 'policy', value: clean };
    }
    if (/Request$/.test(short) || clean.includes('\\Requests\\')) {
      return { kind: 'request', value: clean };
    }
    if (/Event$/.test(short) || clean.includes('\\Events\\')) {
      return { kind: 'event', value: clean };
    }
    if (/Trait$/.test(short) || isTraitUsage(ctx, short)) {
      return { kind: 'trait', value: clean };
    }
    // Services / Actions / Repositories → class (not model)
    if (
      /Service$|Repository$|Action$|DTO$|Dto$/.test(short) ||
      clean.includes('\\Services\\') ||
      clean.includes('\\Repositories\\') ||
      clean.includes('\\Actions\\')
    ) {
      return { kind: 'class', value: clean };
    }

    // Type-hint parameter: MetaWebhookService $webhooks → class
    if (new RegExp(`\\b${escapeRegExp(short)}\\s+\\$`).test(line)) {
      if (clean.includes('\\Models\\') || isLikelyModelName(short)) {
        return { kind: 'model', value: clean };
      }
      return { kind: 'class', value: clean };
    }

    // Model
    if (isModelCandidate(clean, line)) {
      return { kind: 'model', value: clean };
    }

    // Generic class / FQCN
    if (isClassCandidate(clean, ctx)) {
      return { kind: 'class', value: clean };
    }
  }

  return undefined;
}

function shortName(name: string): string {
  return name.includes('\\') ? name.split('\\').pop()! : name;
}

function isViewContext(line: string, viewName: string): boolean {
  const e = escapeRegExp(viewName);
  return [
    new RegExp(`\\bview\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`View::make\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`@include(?:If|When|Unless)?\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`@extends\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`@component\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`@each\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`Route::view\\s*\\([^,]+,\\s*['"]${e}['"]`),
  ].some((p) => p.test(line));
}

function isConfigContext(line: string, key: string): boolean {
  const e = escapeRegExp(key);
  return [
    new RegExp(`\\bconfig\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`Config::(?:get|set)\\s*\\(\\s*['"]${e}['"]`),
  ].some((p) => p.test(line));
}

function isEnvContext(line: string, key: string): boolean {
  const e = escapeRegExp(key);
  return [
    new RegExp(`\\benv\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`Env::(?:get|getOrFail)\\s*\\(\\s*['"]${e}['"]`),
  ].some((p) => p.test(line));
}

function isAssetContext(line: string, assetPath: string): boolean {
  const e = escapeRegExp(assetPath);
  return [
    new RegExp(`\\basset\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`\\bsecure_asset\\s*\\(\\s*['"]${e}['"]`),
  ].some((p) => p.test(line));
}

function isViteContext(ctx: string, entry: string): boolean {
  const e = escapeRegExp(entry);
  return [
    new RegExp(`@vite\\s*\\([^)]*['"]${e}['"]`),
    new RegExp(`Vite::(?:asset|useScriptTag|useStyleTag)?\\s*\\([^)]*['"]${e}['"]`),
  ].some((p) => p.test(ctx));
}

function isLangContext(ctx: string, key: string): boolean {
  const e = escapeRegExp(key);
  return [
    new RegExp(`\\b__\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`\\btrans\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`\\btrans_choice\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`@lang\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`Lang::(?:get|has)\\s*\\(\\s*['"]${e}['"]`),
  ].some((p) => p.test(ctx));
}

function isLikelyEloquentOwner(fqcn: string, short: string): boolean {
  if (fqcn.includes('\\Models\\') || fqcn.includes('\\Model\\')) {
    return true;
  }
  if (/Request$|Controller$|Service$|Repository$|Job$|Mail$|Notification$|Policy$|Middleware$/.test(short)) {
    return false;
  }
  // Plain entity names: User, Post, OrderItem
  return /^[A-Z][A-Za-z0-9]*$/.test(short) && !/Service$|Action$|DTO$/.test(short);
}

/** route('name') / to_route / redirect()->route / ->route / routeIs / Route::has */
function isRouteContext(ctx: string, name: string): boolean {
  const e = escapeRegExp(name);
  return [
    new RegExp(`\\broute\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`\\bto_route\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`->route\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`\\brouteIs\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`Route::has\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`->name\\s*\\(\\s*['"]${e}['"]`), // definition side also resolves to itself
  ].some((p) => p.test(ctx));
}

function isMiddlewareStringContext(line: string, name: string): boolean {
  const e = escapeRegExp(name);
  return [
    new RegExp(`->middleware\\s*\\(\\s*\\[?\\s*['"]${e}['"]`),
    new RegExp(`\\bmiddleware\\s*\\(\\s*['"]${e}['"]`),
  ].some((p) => p.test(line));
}

function isLocalMethodCall(line: string, method: string): boolean {
  const e = escapeRegExp(method);
  return [
    new RegExp(`\\$this\\s*->\\s*${e}\\b`),
    new RegExp(`\\bself\\s*::\\s*${e}\\b`),
    new RegExp(`\\bstatic\\s*::\\s*${e}\\b`),
  ].some((p) => p.test(line));
}

/** `$request->keywordsList` / `$contact?->firstTouchConversation` → `request` / `contact` */
function extractInstanceVar(line: string, method: string): string | undefined {
  const e = escapeRegExp(method);
  const m = line.match(
    new RegExp(`\\$([A-Za-z_][A-Za-z0-9_]*)\\s*\\?->\\s*${e}\\b`)
  ) ?? line.match(
    new RegExp(`\\$([A-Za-z_][A-Za-z0-9_]*)\\s*->\\s*${e}\\b`)
  );
  return m?.[1];
}

/**
 * Infer `$var` type from enclosing function params, @var, assignment,
 * Blade/PHP foreach, or model-name heuristics. Scans upward (capped) — no PHP.
 */
function inferVariableType(
  document: vscode.TextDocument,
  position: vscode.Position,
  varName: string
): string | undefined {
  const e = escapeRegExp(varName);
  const start = Math.max(0, position.line - 120);
  const chunk: string[] = [];
  for (let i = start; i <= position.line; i++) {
    chunk.push(document.lineAt(i).text);
  }
  const text = chunk.join('\n');

  // 1) Parameter / type-hint: only ClassName $var (uppercase). Never match `as $contact`.
  const paramRe = new RegExp(
    `(\\\\?[A-Z][A-Za-z0-9_\\\\]*)\\s+\\$${e}\\b`
  );
  let type: string | undefined;
  let m: RegExpExecArray | null;
  const re = new RegExp(paramRe.source, 'g');
  while ((m = re.exec(text)) !== null) {
    type = m[1].replace(/^\\/, '');
  }
  if (type) {
    return type;
  }

  // 1b) Typed foreach: foreach (array $x as Contact $contact) — rare but valid
  // (covered by uppercase paramRe above when present)

  // 2) @var StoreRuleRequest $request
  const varDoc = text.match(
    new RegExp(`@var\\s+(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)\\s+\\$${e}\\b`)
  );
  if (varDoc) {
    return varDoc[1].replace(/^\\/, '');
  }

  // 3) $request = new StoreRuleRequest
  const newAssign = text.match(
    new RegExp(`\\$${e}\\s*=\\s*new\\s+(\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*)`)
  );
  if (newAssign) {
    return newAssign[1].replace(/^\\/, '');
  }

  // 4) Blade / PHP loop: @forelse ($contacts as $contact) / foreach ($items as $item)
  const loopRe = new RegExp(
    `(?:@(?:foreach|forelse)|\\bforeach)\\s*\\(\\s*\\$([A-Za-z_][A-Za-z0-9_]*)\\s+as\\s+(?:\\$[A-Za-z_][A-Za-z0-9_]*\\s*=>\\s*)?\\$${e}\\b`,
    'g'
  );
  let loopCollection: string | undefined;
  while ((m = loopRe.exec(text)) !== null) {
    loopCollection = m[1];
  }
  if (loopCollection) {
    const fromCollection = guessModelFromVar(loopCollection);
    if (fromCollection) {
      return fromCollection;
    }
  }

  // 5) Blade/PHP-friendly: $contact → Contact, $blogPost → BlogPost
  return guessModelFromVar(varName);
}

/** contacts → Contact, blog_posts → BlogPost, categories → Category */
function guessModelFromVar(varName: string): string | undefined {
  if (!varName || /^(this|self|static)$/.test(varName)) {
    return undefined;
  }
  const singular = singularize(varName);
  const studly = toStudlyCase(singular);
  if (!isLikelyModelName(studly)) {
    return undefined;
  }
  return studly;
}

function singularize(name: string): string {
  if (/ies$/i.test(name) && name.length > 4) {
    return name.replace(/ies$/i, 'y');
  }
  if (/(sses|xes|zes|ches|shes)$/i.test(name)) {
    return name.replace(/es$/i, '');
  }
  if (/s$/i.test(name) && !/ss$/i.test(name) && name.length > 2) {
    return name.replace(/s$/i, '');
  }
  return name;
}

function toStudlyCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('');
}

function isControllerString(value: string): boolean {
  if (/Controller(@\w+)?$/.test(value)) {
    return true;
  }
  return /Controllers?\\/.test(value) && /Controller(@\w+)?$/.test(value);
}

function isControllerActionMethod(ctx: string, method: string): boolean {
  // [SomethingController::class, 'method']
  const e = escapeRegExp(method);
  return new RegExp(
    `Controller::class\\s*,\\s*['"]${e}['"]`
  ).test(ctx);
}

function extractControllerFromActionArray(ctx: string): string | undefined {
  const m = ctx.match(/([A-Za-z0-9_\\]+Controller)::class\s*,\s*['"][^'"]+['"]/);
  return m?.[1];
}

function extractMethodBesideController(ctx: string, ctrlShort: string): string | undefined {
  const e = escapeRegExp(ctrlShort);
  const m = ctx.match(
    new RegExp(`${e}(?:::class)?\\s*,\\s*['"](\\w+)['"]`)
  );
  return m?.[1];
}

function isTraitUsage(ctx: string, short: string): boolean {
  const e = escapeRegExp(short);
  return (
    new RegExp(`\\buse\\s+${e}\\b`).test(ctx) ||
    new RegExp(`\\btrait\\s+${e}\\b`).test(ctx)
  );
}

function isModelCandidate(word: string, line: string): boolean {
  const short = shortName(word);
  if (
    /^(Controller|Request|Middleware|Job|Event|Listener|Policy|Provider|Seeder|Factory|Test|Trait|Service|Repository|Action)$/.test(
      short
    )
  ) {
    return false;
  }
  if (/Controller$|Service$|Repository$|Action$/.test(short)) {
    return false;
  }
  if (word.includes('Models\\') || /\\Models\\/.test(line)) {
    return true;
  }
  if (new RegExp(`\\b${escapeRegExp(short)}\\s*::`).test(line)) {
    return true;
  }
  if (new RegExp(`\\bnew\\s+${escapeRegExp(short)}\\b`).test(line)) {
    return isLikelyModelName(short);
  }
  return false;
}

function isLikelyModelName(short: string): boolean {
  // Heuristic: plain entity names, not *Service etc.
  return (
    /^[A-Z][A-Za-z0-9]*$/.test(short) &&
    !/Service$|Controller$|Repository$|Request$|Middleware$|Provider$|Job$|Listener$|Policy$|Action$/.test(
      short
    )
  );
}

function isClassCandidate(word: string, ctx: string): boolean {
  const short = shortName(word);
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(short) && !word.includes('\\')) {
    return false;
  }
  // Skip primitives / common non-classes
  if (
    /^(String|Int|Array|Bool|True|False|Null|Parent|Self|Static|Mixed)$/i.test(short)
  ) {
    return false;
  }
  const e = escapeRegExp(short);
  return (
    word.includes('\\') ||
    new RegExp(`\\buse\\s+[A-Za-z0-9_\\]*\\\\?${e}\\b`).test(ctx) ||
    new RegExp(`\\b${e}\\s*::`).test(ctx) ||
    new RegExp(`\\bnew\\s+${e}\\b`).test(ctx) ||
    new RegExp(`\\b${e}\\s+\\$`).test(ctx) ||
    new RegExp(`\\bextends\\s+${e}\\b`).test(ctx) ||
    new RegExp(`\\bimplements\\s+[^{;]*\\b${e}\\b`).test(ctx)
  );
}

function stripClassSuffix(name: string): string {
  return name.replace(/::class$/, '').replace(/::$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
