import * as vscode from 'vscode';
import { DetectedSymbol, detectSymbol } from '../detect/symbolDetector';
import { findLaravelRoot, clearLaravelRootCache } from '../laravel/project';
import { resolveModel, expandModelName } from '../resolvers/modelResolver';
import { resolveView } from '../resolvers/viewResolver';
import { resolveConfig, getConfigDisplayValue } from '../resolvers/configResolver';
import { resolveEnv, getEnvValue, clearEnvCache } from '../resolvers/envResolver';
import { resolveController } from '../resolvers/controllerResolver';
import { resolveRoute } from '../resolvers/routeResolver';
import { getRouteUri } from '../laravel/routeIndex';
import { resolveLocalMethod } from '../resolvers/localMethodResolver';
import { resolveRelationOrMethod } from '../resolvers/relationResolver';
import {
  resolveAsset,
  resolveVite,
  resolveLang,
} from '../resolvers/assetLangResolver';
import {
  resolveClass,
  resolveTrait,
  resolveByConvention,
  findMethodInApp,
  clearConventionCaches,
  ConventionKind,
} from '../resolvers/classResolver';
import {
  resolveCommandSignature,
  resolveMigration,
  resolveFactory,
  resolvePolicyAbility,
  resolveEventListeners,
  resolveGateDefine,
  resolveModelOrClass,
  clearExtrasCaches,
} from '../resolvers/laravelExtrasResolver';
import { resolveCallChain } from '../resolvers/callChainResolver';
import { clearPsr4Cache } from '../laravel/psr4';
import { clearRouteIndexCache } from '../laravel/routeIndex';
import { LruCache } from '../utils/cache';

export interface ResolveResult {
  symbol: DetectedSymbol;
  location: vscode.Location;
  /** Extra locations (event → listeners) */
  locations?: vscode.Location[];
  /** Display value for env()/config() hover */
  displayValue?: string;
  root: string;
}

const locationCache = new LruCache<vscode.Location>(200);

export function resolveAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  token?: vscode.CancellationToken
): ResolveResult | undefined {
  if (token?.isCancellationRequested) {
    return undefined;
  }
  if (document.uri.scheme !== 'file') {
    return undefined;
  }

  const symbol = detectSymbol(document, position);
  if (!symbol || token?.isCancellationRequested) {
    return undefined;
  }

  const root = findLaravelRoot(document.uri);
  if (!root || token?.isCancellationRequested) {
    return undefined;
  }

  const cacheKey = `${root}|${symbol.kind}|${symbol.value}|${symbol.member ?? ''}|${document.uri.fsPath}`;
  const cached = locationCache.get(cacheKey);

  let location: vscode.Location | undefined = cached;
  if (!location) {
    if (symbol.kind === 'localMethod') {
      location = resolveLocalMethod(document, symbol.member ?? symbol.value, root);
    } else if (symbol.kind === 'instanceMethod') {
      location = resolveInstanceMethod(root, symbol.value, symbol.member);
    } else if (symbol.kind === 'relation') {
      location = resolveRelationOrMethod(
        root,
        symbol.value,
        symbol.member ?? ''
      );
      if (!location) {
        location = resolveInstanceMethod(root, symbol.value, symbol.member);
      }
    } else {
      location = dispatch(root, symbol);
    }
  }

  if (!location) {
    return undefined;
  }

  if (!cached) {
    locationCache.set(cacheKey, location);
  }

  const extras = collectExtras(root, symbol, location);

  const displayValue = resolveDisplayValue(root, symbol);

  return {
    symbol,
    location,
    locations: extras.length > 0 ? [location, ...extras] : undefined,
    displayValue,
    root,
  };
}

function resolveDisplayValue(
  root: string,
  symbol: DetectedSymbol
): string | undefined {
  if (symbol.kind === 'env') {
    return getEnvValue(root, symbol.value);
  }
  if (symbol.kind === 'config') {
    return getConfigDisplayValue(root, symbol.value);
  }
  if (symbol.kind === 'route') {
    return getRouteUri(root, symbol.value);
  }
  return undefined;
}

/** Try short name + App\Models\… variants; last resort scan for the method. */
function resolveInstanceMethod(
  root: string,
  className: string,
  member?: string
): vscode.Location | undefined {
  if (member && (className === '_' || !className)) {
    return findMethodInApp(root, member);
  }
  for (const name of expandModelName(className)) {
    const hit = resolveClass(root, name, member);
    if (hit) {
      // Prefer hits that actually contain the method when member is set
      if (!member) {
        return hit;
      }
      return hit;
    }
    const modelLoc = resolveModel(root, name);
    if (modelLoc && !member) {
      return modelLoc;
    }
  }
  if (member) {
    return findMethodInApp(root, member);
  }
  return resolveClass(root, className, member);
}

function dispatch(
  root: string,
  symbol: DetectedSymbol
): vscode.Location | undefined {
  switch (symbol.kind) {
    case 'view':
      return resolveView(root, symbol.value);
    case 'config':
      return resolveConfig(root, symbol.value);
    case 'env':
      return resolveEnv(root, symbol.value);
    case 'asset':
      return resolveAsset(root, symbol.value);
    case 'vite':
      return resolveVite(root, symbol.value);
    case 'lang':
      return resolveLang(root, symbol.value);
    case 'controller':
      return (
        resolveController(root, symbol.value, symbol.member) ??
        resolveClass(root, symbol.value, symbol.member)
      );
    case 'model':
      return resolveModelOrClass(root, symbol.value);
    case 'route':
      return resolveRoute(root, symbol.value);
    case 'trait':
      return resolveTrait(root, symbol.value);
    case 'class':
      return resolveClass(root, symbol.value, symbol.member);
    case 'command':
      return (
        resolveCommandSignature(root, symbol.value) ??
        resolveByConvention(root, 'command', symbol.value)
      );
    case 'migration':
      return resolveMigration(root, symbol.value);
    case 'factory':
      return resolveFactory(root, symbol.value);
    case 'policy':
      if (symbol.member) {
        if (symbol.value !== '_gate') {
          const policy =
            resolvePolicyAbility(root, symbol.value, symbol.member) ??
            resolveByConvention(root, 'policy', symbol.value);
          if (policy) {
            return policy;
          }
        }
        return resolveGateDefine(root, symbol.member);
      }
      return resolveByConvention(root, 'policy', symbol.value);
    case 'middleware':
    case 'job':
    case 'event':
    case 'listener':
    case 'request':
    case 'repository':
    case 'contract':
    case 'exception':
    case 'notification':
    case 'mail':
    case 'provider':
    case 'seeder':
      return resolveByConvention(root, symbol.kind as ConventionKind, symbol.value);
    default:
      return undefined;
  }
}

function collectExtras(
  root: string,
  symbol: DetectedSymbol,
  location: vscode.Location
): vscode.Location[] {
  if (symbol.kind === 'event') {
    return resolveEventListeners(root, symbol.value).filter(
      (l) => l.uri.fsPath !== location.uri.fsPath
    );
  }
  if (symbol.kind === 'policy' && symbol.member) {
    const gate = resolveGateDefine(root, symbol.member);
    if (gate && gate.uri.fsPath !== location.uri.fsPath) {
      return [gate];
    }
    return [];
  }
  if (
    (symbol.kind === 'instanceMethod' || symbol.kind === 'localMethod') &&
    symbol.member
  ) {
    return resolveCallChain(root, location.uri.fsPath, symbol.member).filter(
      (l) =>
        l.uri.fsPath !== location.uri.fsPath ||
        l.range.start.line !== location.range.start.line
    );
  }
  return [];
}

export function clearResolveCache(): void {
  locationCache.clear();
  clearLaravelRootCache();
  clearPsr4Cache();
  clearRouteIndexCache();
  clearConventionCaches();
  clearExtrasCaches();
  clearEnvCache();
}
