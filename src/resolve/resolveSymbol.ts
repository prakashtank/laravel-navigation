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
} from '../resolvers/classResolver';
import { clearPsr4Cache } from '../laravel/psr4';
import { clearRouteIndexCache } from '../laravel/routeIndex';
import { LruCache } from '../utils/cache';

export interface ResolveResult {
  symbol: DetectedSymbol;
  location: vscode.Location;
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

  const displayValue = resolveDisplayValue(root, symbol);

  return { symbol, location, displayValue, root };
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
      return resolveController(root, symbol.value, symbol.member);
    case 'model':
      return resolveModel(root, symbol.value);
    case 'route':
      return resolveRoute(root, symbol.value);
    case 'trait':
      return resolveTrait(root, symbol.value);
    case 'class':
      return resolveClass(root, symbol.value, symbol.member);
    case 'middleware':
    case 'job':
    case 'event':
    case 'listener':
    case 'policy':
    case 'request':
      return resolveByConvention(root, symbol.kind, symbol.value);
    default:
      return undefined;
  }
}

export function clearResolveCache(): void {
  locationCache.clear();
  clearLaravelRootCache();
  clearPsr4Cache();
  clearRouteIndexCache();
  clearConventionCaches();
  clearEnvCache();
}
