# Changelog

## 1.1.0 — 2026-09-23

- Repository, contract/interface, exception, notification, mail, command, provider, seeder, factory, migration navigation
- `$this->call('command:name')` / `Artisan::call` → console command
- `Schema::create('users')` → migration file
- `User::factory()` → factory class
- `$this->authorize('update', $user)` / `Gate::allows` / `@can` → policy method
- Middleware aliases with parameters (`permission:users.create`)
- Event → listener extra definitions (EventServiceProvider + listener scan)
- Nested `app/Models` resolve and model → class fallback
- `routes/web.php`: hover + open on route controller class and action method (`[Ctrl::class, 'index']`, `Route::controller`)
- Service method → repository / model extras (`$userService->createUser()`)
- `Notification::send` / `Mail::to()->send` / `->notify(new …)`
- `Gate::define` and `permission:users.create` ability strings
- `SendEmailJob::dispatch()` / `dispatch(new SendEmailJob)`

## 1.0.1 — 2026-09-23

- Marketplace README screenshots load from the package (no private GitHub rewrite)
- Removed the internal publish-doc link from the public listing

## 1.0.0 — 2026-09-23

First public Marketplace release.

- Ctrl+Hover preview and Ctrl+Click for models, views, routes, config, env, controllers, classes, and conventions
- Env + config hover values (`env()`, `config()`)
- Jump to `.env` / nested config keys
- `$this->method()`, typed `$request->method()`
- Eloquent relation → related model
- `asset()`, `@vite`, `__()` / `trans()` / `@lang`
- Illuminate / vendor PSR-4 resolve
- Named route Find All References
- Hover feedback link (Prakash Tank)
- Lightweight: no PHP process, no Artisan, no background indexing
