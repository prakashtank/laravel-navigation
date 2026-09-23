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
  | 'repository'
  | 'contract'
  | 'exception'
  | 'command'
  | 'notification'
  | 'mail'
  | 'provider'
  | 'seeder'
  | 'factory'
  | 'migration'
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
  const routesFile = isRoutesDocument(document);
  const ctx = getLineContext(document, position, routesFile ? 8 : 1);
  const wide = getLineContext(document, position, 4);
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

  // --- Controller@method string (before named routes) ---
  if (stringLit !== undefined && isControllerString(stringLit)) {
    const [ctrl, method] = stringLit.split('@');
    return { kind: 'controller', value: ctrl, member: method };
  }

  // --- [Controller::class, 'method'] / Route::controller() — cursor on method ---
  if (stringLit !== undefined) {
    const action = findControllerActionAtString(document, position, stringLit);
    if (action) {
      return {
        kind: 'controller',
        value: resolveUseImport(document, action.ctrl),
        member: action.method,
      };
    }
  }

  // --- Named route (route() / reverse routing) ---
  if (stringLit !== undefined && isRouteContext(ctx, stringLit)) {
    return { kind: 'route', value: stringLit };
  }

  // --- Artisan command signature ---
  if (stringLit !== undefined && isCommandStringContext(ctx, stringLit)) {
    return { kind: 'command', value: stringLit };
  }

  // --- Schema::create('users') ---
  if (stringLit !== undefined && isMigrationStringContext(line, stringLit)) {
    return { kind: 'migration', value: stringLit };
  }

  // --- $this->authorize / Gate::allows / Gate::define / @can / ->can ---
  if (stringLit !== undefined && isAuthorizeAbilityContext(wide, stringLit)) {
    const model =
      extractAuthorizeModelHint(wide) ??
      guessPolicyModelFromController(document);
    return { kind: 'policy', value: model ?? '_gate', member: stringLit };
  }

  // --- Middleware alias; cursor after ':' is the permission/ability ---
  if (stringLit !== undefined && isMiddlewareStringContext(line, stringLit)) {
    const ability = permissionAbilityAtCursor(document, position, stringLit);
    if (ability) {
      return { kind: 'policy', value: '_gate', member: ability };
    }
    return { kind: 'middleware', value: stringLit };
  }

  // --- Job::dispatch() / dispatch(new Job) — cursor on dispatch ---
  if (word && isJobDispatchWord(word)) {
    const job = extractDispatchedClass(wide);
    if (job) {
      return { kind: 'job', value: resolveUseImport(document, job) };
    }
  }

  // --- Notification::send / Mail::to()->send — cursor on send/notify ---
  if (word && isNotifyMailSendWord(word)) {
    const notice = extractNewClassInNotifyContext(wide);
    if (notice) {
      return { kind: 'notification', value: resolveUseImport(document, notice) };
    }
    const mailable = extractNewClassInMailContext(wide);
    if (mailable) {
      return { kind: 'mail', value: resolveUseImport(document, mailable) };
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

    // Controller class (+ method from [Ctrl::class, 'index'] or next line)
    if (/Controller$/.test(short)) {
      const member = extractMethodAfterController(document, position);
      return { kind: 'controller', value: clean, member };
    }

    // routes/web.php: [SomeAction::class, 'handle'] without *Controller suffix
    if (routesFile) {
      const routeMember = extractMethodAfterController(document, position);
      if (
        routeMember &&
        new RegExp(`${escapeRegExp(short)}::class`).test(ctx)
      ) {
        return { kind: 'controller', value: clean, member: routeMember };
      }
    }

    // Convention suffixes
    if (/Middleware$/.test(short) || clean.includes('\\Middleware\\')) {
      return { kind: 'middleware', value: clean };
    }
    if (/Job$/.test(short) || clean.includes('\\Jobs\\')) {
      return { kind: 'job', value: clean };
    }
    if (isJobDispatchContext(wide, short)) {
      return { kind: 'job', value: clean };
    }
    if (isNotificationPayloadContext(wide, short)) {
      return { kind: 'notification', value: clean };
    }
    if (isMailPayloadContext(wide, short)) {
      return { kind: 'mail', value: clean };
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
    if (/Repository$/.test(short) || clean.includes('\\Repositories\\')) {
      return { kind: 'repository', value: clean };
    }
    if (
      /Interface$|Contract$/.test(short) ||
      clean.includes('\\Contracts\\') ||
      clean.includes('\\Interfaces\\')
    ) {
      return { kind: 'contract', value: clean };
    }
    if (/Exception$/.test(short) || clean.includes('\\Exceptions\\')) {
      return { kind: 'exception', value: clean };
    }
    if (/Command$/.test(short) || clean.includes('\\Console\\Commands\\')) {
      return { kind: 'command', value: clean };
    }
    if (/Notification$/.test(short) || clean.includes('\\Notifications\\')) {
      return { kind: 'notification', value: clean };
    }
    if (/Mail$|Mailable$/.test(short) || clean.includes('\\Mail\\')) {
      return { kind: 'mail', value: clean };
    }
    if (
      /Provider$|ServiceProvider$/.test(short) ||
      clean.includes('\\Providers\\')
    ) {
      return { kind: 'provider', value: clean };
    }
    if (/Seeder$/.test(short)) {
      return { kind: 'seeder', value: clean };
    }
    if (/Factory$/.test(short) || isFactoryCall(line, short)) {
      return { kind: 'factory', value: factoryOwner(line, clean, short) };
    }
    if (
      /^Create\w+Table$/.test(short) ||
      clean.includes('\\Migrations\\')
    ) {
      return { kind: 'migration', value: clean };
    }
    // Services / Actions / DTOs → class (not model)
    if (
      /Service$|Action$|DTO$|Dto$/.test(short) ||
      clean.includes('\\Services\\') ||
      clean.includes('\\Actions\\')
    ) {
      return { kind: 'class', value: clean };
    }

    // Type-hint / return type / docblock: User $user, ): User, : ?User
    if (isPhpTypePosition(line, short)) {
      if (clean.includes('\\Models\\') || isLikelyModelName(short)) {
        return { kind: 'model', value: clean };
      }
      return { kind: 'class', value: clean };
    }

    // Model (imported FQCN, User::, new User, or Models\ on the line)
    if (isModelCandidate(clean, line)) {
      return { kind: 'model', value: clean };
    }

    // Bare Post / User after a Models import, or in a controller
    if (
      isLikelyModelName(short) &&
      (clean.includes('\\Models\\') ||
        isControllerDocument(document) ||
        fileMentionsModels(document))
    ) {
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

function isCommandStringContext(ctx: string, name: string): boolean {
  const e = escapeRegExp(name);
  return [
    new RegExp(`\\$this\\s*->\\s*call\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`Artisan::call\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`->command\\s*\\(\\s*['"]${e}['"]`),
  ].some((p) => p.test(ctx));
}

function isMigrationStringContext(line: string, table: string): boolean {
  const e = escapeRegExp(table);
  return new RegExp(`Schema::(?:create|table)\\(\\s*['"]${e}['"]`).test(line);
}

function isAuthorizeAbilityContext(ctx: string, ability: string): boolean {
  const e = escapeRegExp(ability);
  return [
    new RegExp(`\\bauthorize(?:ForUser)?\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(
      `Gate::(?:allows|denies|authorize|check|any|none|inspect|define)\\s*\\(\\s*['"]${e}['"]`
    ),
    new RegExp(`@can(?:any)?\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`->can(?:not)?\\s*\\(\\s*['"]${e}['"]`),
    new RegExp(`\\bhasPermission(?:To)?\\s*\\(\\s*['"]${e}['"]`),
  ].some((p) => p.test(ctx));
}

function extractAuthorizeModelHint(ctx: string): string | undefined {
  const classRef = ctx.match(
    /(?:authorize(?:ForUser)?|Gate::(?:allows|denies|authorize|check)|@can(?:any)?|->can(?:not)?|hasPermission(?:To)?)\s*\(\s*['"][^'"]+['"]\s*,\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class/
  );
  if (classRef) {
    return classRef[1].replace(/^\\/, '');
  }
  const varRef = ctx.match(
    /(?:authorize(?:ForUser)?|Gate::(?:allows|denies|authorize|check)|@can(?:any)?|->can(?:not)?|hasPermission(?:To)?)\s*\(\s*['"][^'"]+['"]\s*,\s*\$([A-Za-z_][A-Za-z0-9_]*)/
  );
  return varRef?.[1];
}

function guessPolicyModelFromController(
  document: vscode.TextDocument
): string | undefined {
  const base =
    document.uri.fsPath.replace(/\\/g, '/').split('/').pop()?.replace(/\.php$/i, '') ??
    '';
  if (!/Controller$/.test(base) || base === 'Controller') {
    return undefined;
  }
  return base.replace(/Controller$/, '');
}

function permissionAbilityAtCursor(
  document: vscode.TextDocument,
  position: vscode.Position,
  stringLit: string
): string | undefined {
  if (!/^(permission|can|role):/.test(stringLit)) {
    return undefined;
  }
  const line = document.lineAt(position.line).text;
  const start = line.indexOf(stringLit);
  if (start < 0) {
    return undefined;
  }
  const colonCol = start + stringLit.indexOf(':');
  if (position.character <= colonCol) {
    return undefined;
  }
  return stringLit.slice(stringLit.indexOf(':') + 1) || undefined;
}

function isJobDispatchWord(word: string): boolean {
  return /^(dispatch|dispatchSync|dispatchNow|dispatchAfterResponse|dispatch_sync)$/.test(
    word
  );
}

function isNotifyMailSendWord(word: string): boolean {
  return /^(send|sendNow|notify|notifyNow|queue|later)$/.test(word);
}

function extractDispatchedClass(ctx: string): string | undefined {
  const staticJob = ctx.match(
    /\\?([A-Z][A-Za-z0-9_\\]*)\s*::\s*(?:dispatch|dispatchSync|dispatchAfterResponse)\s*\(/
  );
  if (staticJob) {
    return staticJob[1];
  }
  const helper = ctx.match(
    /(?:\bdispatch(?:_sync)?|Bus::dispatch(?:Now|Sync)?)\s*\(\s*new\s+\\?([A-Z][A-Za-z0-9_\\]*)/
  );
  return helper?.[1];
}

function extractNewClassInNotifyContext(ctx: string): string | undefined {
  if (!/Notification::|(?:->|\s)notify(?:Now)?\s*\(/.test(ctx)) {
    return undefined;
  }
  return firstNewClass(ctx);
}

function extractNewClassInMailContext(ctx: string): string | undefined {
  if (!/Mail::/.test(ctx)) {
    return undefined;
  }
  return firstNewClass(ctx);
}

function firstNewClass(ctx: string): string | undefined {
  const m = ctx.match(/\bnew\s+\\?([A-Z][A-Za-z0-9_\\]*)/);
  if (!m || /^(DateTime|Carbon|Collection|Request|Exception)/.test(m[1])) {
    return undefined;
  }
  return m[1];
}

function isJobDispatchContext(ctx: string, short: string): boolean {
  const e = escapeRegExp(short);
  return (
    new RegExp(
      `${e}\\s*::\\s*(?:dispatch|dispatchSync|dispatchAfterResponse)\\s*\\(`
    ).test(ctx) ||
    new RegExp(
      `(?:\\bdispatch(?:_sync)?|Bus::dispatch(?:Now|Sync)?)\\s*\\(\\s*new\\s+\\\\?${e}\\b`
    ).test(ctx)
  );
}

function isNotificationPayloadContext(ctx: string, short: string): boolean {
  if (!/Notification::|(?:->|\s)notify(?:Now)?\s*\(/.test(ctx)) {
    return false;
  }
  return new RegExp(`new\\s+\\\\?${escapeRegExp(short)}\\b`).test(ctx);
}

function isMailPayloadContext(ctx: string, short: string): boolean {
  if (!/Mail::/.test(ctx)) {
    return false;
  }
  return new RegExp(`new\\s+\\\\?${escapeRegExp(short)}\\b`).test(ctx);
}

function isFactoryCall(line: string, word: string): boolean {
  if (word !== 'factory') {
    return false;
  }
  return /[A-Z][A-Za-z0-9_]*\s*::\s*factory\s*\(/.test(line);
}

function factoryOwner(line: string, clean: string, short: string): string {
  if (short !== 'factory') {
    return clean;
  }
  const m = line.match(/([A-Z][A-Za-z0-9_]*)\s*::\s*factory\s*\(/);
  return m?.[1] ?? clean;
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
  const start = Math.max(0, position.line - 200);
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

function isRoutesDocument(document: vscode.TextDocument): boolean {
  return /\/routes\//.test(document.uri.fsPath.replace(/\\/g, '/'));
}

/**
 * Cursor is on the action string: [Ctrl::class, 'index'] or Route::get(..., 'index')
 * inside Route::controller(Ctrl::class). Looks only at text *before* the string
 * so ->name('index') on the same line is not stolen.
 */
function findControllerActionAtString(
  document: vscode.TextDocument,
  position: vscode.Position,
  method: string
): { ctrl: string; method: string } | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(method)) {
    return undefined;
  }
  const before = textBeforeStringLiteral(document, position);
  const arrayCtrl = before.match(
    /\\?([A-Za-z_][A-Za-z0-9_\\]*)::class\s*,\s*$/
  );
  if (arrayCtrl) {
    return { ctrl: stripClassSuffix(arrayCtrl[1]), method };
  }

  if (!isRoutesDocument(document) || !isRouteHttpCallBefore(before)) {
    return undefined;
  }
  const grouped = findRouteControllerGroup(document, position);
  if (grouped) {
    return { ctrl: grouped, method };
  }
  return undefined;
}

function textBeforeStringLiteral(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const line = document.lineAt(position.line).text;
  const col = position.character;
  let start = col;
  for (let i = col; i >= 0; i--) {
    if (
      (line[i] === "'" || line[i] === '"') &&
      (i === 0 || line[i - 1] !== '\\')
    ) {
      start = i;
      break;
    }
  }
  const lookback = Math.max(0, position.line - 12);
  const prev: string[] = [];
  for (let i = lookback; i < position.line; i++) {
    prev.push(document.lineAt(i).text);
  }
  return `${prev.join('\n')}\n${line.slice(0, start)}`;
}

function isRouteHttpCallBefore(before: string): boolean {
  const last = before.split('\n').pop() ?? before;
  return /(?:Route::|->)(?:get|post|put|patch|delete|options|any|match)\s*\(\s*(?:['"][^'"]*['"]|[^,()\n]+)\s*,\s*$/.test(
    last
  );
}

function findRouteControllerGroup(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const start = Math.max(0, position.line - 50);
  for (let i = position.line; i >= start; i--) {
    const m = document
      .lineAt(i)
      .text.match(
        /Route::controller\(\s*\\?([A-Za-z_][A-Za-z0-9_\\]*)::class/
      );
    if (m) {
      return stripClassSuffix(m[1]);
    }
  }
  return undefined;
}

/** Method string after UserController::class on this or the next few lines. */
function extractMethodAfterController(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  const line = document.lineAt(position.line).text;
  let end = position.character;
  while (end < line.length && /[A-Za-z0-9_\\]/.test(line[end])) {
    end++;
  }
  const after: string[] = [line.slice(end)];
  const last = Math.min(document.lineCount - 1, position.line + 6);
  for (let i = position.line + 1; i <= last; i++) {
    after.push(document.lineAt(i).text);
  }
  const text = after.join('\n');
  const m = text.match(/^\s*::class\s*,\s*['"](\w+)['"]/);
  return m?.[1];
}

function fileMentionsModels(document: vscode.TextDocument): boolean {
  const max = Math.min(document.lineCount, 80);
  for (let i = 0; i < max; i++) {
    const t = document.lineAt(i).text;
    if (/\\Models\\/.test(t) || /namespace\s+[A-Za-z0-9_\\]*Models\b/.test(t)) {
      return true;
    }
    if (/^\s*(class|interface|trait|enum)\s+/.test(t)) {
      break;
    }
  }
  return false;
}

function isTraitUsage(ctx: string, short: string): boolean {
  const e = escapeRegExp(short);
  return (
    new RegExp(`\\buse\\s+${e}\\b`).test(ctx) ||
    new RegExp(`\\btrait\\s+${e}\\b`).test(ctx)
  );
}

function isPhpTypePosition(line: string, short: string): boolean {
  const e = escapeRegExp(short);
  return [
    new RegExp(`\\b${e}\\s+\\$`),
    new RegExp(`\\)\\s*:\\s*\\??${e}\\b`),
    new RegExp(`:\\s*\\??${e}\\b`),
    new RegExp(`\\b${e}\\s*[|&]`),
    new RegExp(`[|&]\\s*\\??${e}\\b`),
    new RegExp(`@(?:var|param|return|property(?:-read|-write)?)\\s+\\??(?:\\\\[A-Za-z0-9_\\\\]*\\\\)?${e}\\b`),
  ].some((p) => p.test(line));
}

function isControllerDocument(document: vscode.TextDocument): boolean {
  const fsPath = document.uri.fsPath.replace(/\\/g, '/');
  return /\/Http\/Controllers\//.test(fsPath) || /Controller\.php$/i.test(fsPath);
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
    return (
      isLikelyModelName(short) ||
      word.includes('Models\\') ||
      /\\Models\\/.test(line)
    );
  }
  if (new RegExp(`\\bnew\\s+${escapeRegExp(short)}\\b`).test(line)) {
    return isLikelyModelName(short);
  }
  return false;
}

function isLikelyModelName(short: string): boolean {
  // Heuristic: plain entity names, not *Service / facades
  if (
    /^(Route|Auth|Gate|Schema|Config|View|Mail|Notification|Event|Queue|Cache|DB|Log|Hash|Crypt|Storage|Session|Cookie|Redirect|Response|App|Artisan|Blade|Broadcast|Bus|File|Http|Lang|Password|Redis|URL|Validator|Vite|Str|Arr)$/.test(
      short
    )
  ) {
    return false;
  }
  return (
    /^[A-Z][A-Za-z0-9]*$/.test(short) &&
    !/Service$|Controller$|Repository$|Request$|Middleware$|Provider$|Job$|Listener$|Policy$|Action$|Exception$|Notification$|Mail$|Mailable$|Interface$|Contract$|Command$|Seeder$|Factory$/.test(
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
