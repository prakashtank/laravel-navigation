import * as path from 'path';

export function modelCandidates(root: string, className: string): string[] {
  const short = className.includes('\\')
    ? className.split('\\').pop()!
    : className;

  const candidates = [
    path.join(root, 'app', 'Models', `${short}.php`),
    path.join(root, 'app', `${short}.php`),
  ];

  const parts = className.split('\\');
  const modelsIdx = parts.indexOf('Models');
  if (modelsIdx >= 0 && modelsIdx < parts.length - 1) {
    candidates.push(
      path.join(
        root,
        'app',
        ...parts.slice(modelsIdx).map((p, i, a) =>
          i === a.length - 1 ? `${p}.php` : p
        )
      )
    );
  }

  return candidates;
}

export function viewCandidates(root: string, viewName: string): string[] {
  if (viewName.includes('::')) {
    const [ns, rest] = viewName.split('::', 2);
    const parts = rest.replace(/\./g, path.sep);
    return [
      path.join(root, 'resources', 'views', ns, `${parts}.blade.php`),
      path.join(root, 'resources', 'views', ns, `${parts}.php`),
      path.join(root, 'Modules', ns, 'Resources', 'views', `${parts}.blade.php`),
      path.join(root, 'modules', ns, 'Resources', 'views', `${parts}.blade.php`),
    ];
  }

  const parts = viewName.replace(/\./g, path.sep);
  return [
    path.join(root, 'resources', 'views', `${parts}.blade.php`),
    path.join(root, 'resources', 'views', `${parts}.php`),
  ];
}

export function configFilePath(root: string, configKey: string): string {
  const file = configKey.split('.')[0];
  return path.join(root, 'config', `${file}.php`);
}

export function controllerFileName(className: string): string {
  const short = className.includes('\\')
    ? className.split('\\').pop()!
    : className.replace(/@.*$/, '');
  return `${short}.php`;
}

export function controllerCandidates(root: string, className: string): string[] {
  const fileName = controllerFileName(className);
  const short = fileName.replace(/\.php$/, '');

  const parts = className.replace(/@.*$/, '').split('\\');
  const ctrlIdx = parts.findIndex((p) => p === 'Controllers');
  if (ctrlIdx >= 0 && ctrlIdx < parts.length - 1) {
    return [
      path.join(
        root,
        'app',
        'Http',
        'Controllers',
        ...parts.slice(ctrlIdx + 1).map((p, i, a) =>
          i === a.length - 1 ? `${p}.php` : p
        )
      ),
      path.join(root, 'app', 'Http', 'Controllers', `${short}.php`),
    ];
  }

  return [path.join(root, 'app', 'Http', 'Controllers', `${short}.php`)];
}

export function controllersBase(root: string): string {
  return path.join(root, 'app', 'Http', 'Controllers');
}
