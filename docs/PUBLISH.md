# Marketplace publish guide

This guide explains **what appears in the VS Code / Cursor Extensions search UI** and **where that content comes from**.

---

## When you search in VS Code / Cursor

```
┌─────────────────────────────┬──────────────────────────────────┐
│  Search results (left)      │  Extension details (right)       │
│                             │                                  │
│  [ICON] displayName         │  [ICON] displayName              │
│  short description          │  Install | description            │
│  publisher · downloads      │                                  │
│                             │  README (full docs)              │
│                             │  Changelog                       │
│                             │  …                               │
└─────────────────────────────┴──────────────────────────────────┘
```

| What you see in the UI | Source file / field |
|------------------------|---------------------|
| **Icon** (list + detail) | [`package.json`](../package.json) → `"icon": "images/icon.png"` |
| **Name** (title) | `"displayName"` |
| **Short description** (search list + header) | `"description"` (one short line) |
| **Publisher name** | `"publisher"` (ID created on the Marketplace) |
| **Categories / tags** | `"categories"`, `"keywords"` |
| **Full docs on the right** | **[`README.md`](../README.md)** (most important) |
| **Changelog tab** | [`CHANGELOG.md`](../CHANGELOG.md) |
| **License** | [`LICENSE`](../LICENSE) + `"license"` |
| **Version** | `"version"` |
| **Repo / bugs / homepage links** | `"repository"`, `"bugs"`, `"homepage"` (optional but recommended) |
| **Banner color** (Marketplace website) | `"galleryBanner"` |

**Important:** The long description on the right comes from **`README.md`**. You do not type it separately in the Marketplace UI. Keep the README clear; add screenshots if useful.

---

## Pre-publish checklist

1. [ ] `images/icon.png` — square PNG, at least **128×128** (project includes a generated icon)
2. [ ] Finalize `displayName` + `description`
3. [ ] `README.md` complete for developers
4. [ ] `CHANGELOG.md` present
5. [ ] Create the `publisher` ID on the Marketplace
6. [ ] Azure DevOps Personal Access Token with **Marketplace (Publish)** scope for `vsce login`
7. [ ] `npm run package` succeeds
8. [ ] Publish with a release script (below)

---

## Create a publisher account

1. Open: https://marketplace.visualstudio.com/manage  
2. Sign in with a Microsoft account  
3. **Create publisher** → choose an ID (example: `prakashtank`)  
   - This ID must **exactly match** `"publisher"` in `package.json`  
4. Create an Azure DevOps PAT with scope **Marketplace (Publish)**  
5. Log in:

```bash
npx vsce login prakashtank
# paste the PAT when prompted
```

6. Publish (**auto version bump**):

```bash
# first-time login (if needed)
npx vsce login prakashtank

# bugfix / small change  →  1.0.0 → 1.0.1
npm run release:patch

# new feature               →  1.0.0 → 1.1.0
npm run release:minor

# breaking change           →  1.0.0 → 2.0.0
npm run release:major

# bump locally only; do not publish
npm run release:dry
```

What `scripts/release.cjs` does:

1. Bumps `"version"` in `package.json` (semver)
2. Adds an entry to `CHANGELOG.md`
3. Runs `vsce publish` to upload to the Marketplace

**Manual publish** (no bump): set the version yourself, then run `npm run publish:marketplace`.

**Note:** The hover card brand text follows the published version (for example `laravel-navigation 1.0.1`).

README screenshots must use **public** GitHub raw URLs (or another public host). A private repo will break Marketplace images.

After a few minutes, search in VS Code:

```
laravel-navigation
```

or

```
@publisher:prakashtank
```

---

## `package.json` fields (configured in this project)

| Field | Purpose |
|-------|---------|
| `name` | Unique extension id (with publisher → `prakashtank.laravel-navigation`) |
| `displayName` | Human-readable title in the UI |
| `description` | One-line blurb in search results |
| `icon` | Path to the logo |
| `categories` | Marketplace filters |
| `keywords` | Search / discovery |
| `galleryBanner` | Header color on the Marketplace website |
| `license` | Shown on the extension page |

---

## Tip: screenshots (optional, in README)

You can add images to the README:

```markdown
![Hover card](https://raw.githubusercontent.com/YOU/REPO/main/images/screenshot-hover.png)
```

Marketplace README images work best with **absolute URLs** (GitHub raw / CDN). Relative local paths often break on the Marketplace page.

---

## Feedback / author

Prakash Tank — prakashtank106@gmail.com  

(The blue button on the hover card opens mail to the same address.)
