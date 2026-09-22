#!/usr/bin/env node
/**
 * Auto-increment version + update CHANGELOG + publish to Marketplace.
 *
 * Usage:
 *   npm run release:patch   → 1.0.0 → 1.0.1
 *   npm run release:minor   → 1.0.0 → 1.1.0
 *   npm run release:major   → 1.0.0 → 2.0.0
 *
 * Options:
 *   --dry-run   bump locally, do not publish
 *   --no-publish  same as dry-run for publish step skip (still writes files)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

const args = process.argv.slice(2);
const bump = args.find((a) => ['patch', 'minor', 'major'].includes(a)) || 'patch';
const dryRun = args.includes('--dry-run') || args.includes('--no-publish');

function bumpSemver(version, type) {
  const parts = version.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid version: ${version}`);
  }
  let [major, minor, patch] = parts;
  if (type === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
const newVersion = bumpSemver(oldVersion, bump);

pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const today = new Date().toISOString().slice(0, 10);
const entry =
  `## ${newVersion}\n\n` +
  `- Release ${today} (${bump} bump from ${oldVersion})\n` +
  `- See git history / PR notes for detailed changes.\n\n`;

let changelog = '';
if (fs.existsSync(changelogPath)) {
  changelog = fs.readFileSync(changelogPath, 'utf8');
  if (changelog.startsWith('# Changelog')) {
    changelog = changelog.replace(/^# Changelog\s*\n+/, `# Changelog\n\n${entry}`);
  } else {
    changelog = `# Changelog\n\n${entry}${changelog}`;
  }
} else {
  changelog = `# Changelog\n\n${entry}`;
}
fs.writeFileSync(changelogPath, changelog);

console.log(`Version: ${oldVersion} → ${newVersion} (${bump})`);

if (dryRun) {
  console.log('Dry run: skipped Marketplace publish. Files updated locally.');
  process.exit(0);
}

console.log('Publishing to Visual Studio Marketplace…');
execSync('npx vsce publish --allow-missing-repository', {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

console.log(`Published ${pkg.publisher}.${pkg.name}@${newVersion}`);
