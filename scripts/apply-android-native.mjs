#!/usr/bin/env node
/**
 * Apply MusiX's native Android code to the generated Capacitor project.
 *
 * android/ is created on the build machine by `npx cap add android` and is not
 * tracked (docs/ANDROID.md), so the pieces MusiX adds to it live in
 * native/android/ and are applied by this script:
 *
 *   1. copy MusicLibraryPlugin.java next to MainActivity (package rewritten to
 *      match MainActivity's, in case the app id differs);
 *   2. register the plugin in MainActivity before super.onCreate — handles a
 *      Java or Kotlin MainActivity, with or without an onCreate;
 *   3. merge AndroidManifest.additions.xml into the app manifest.
 *
 * Idempotent: running it twice leaves the project unchanged. No dependencies.
 * Usage: npm run android:native
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = join(repo, 'native', 'android');
const appMain = join(repo, 'android', 'app', 'src', 'main');
const PLUGIN = 'MusicLibraryPlugin';

function fail(message) {
  console.error(`apply-android-native: ${message}`);
  process.exit(1);
}

function report(message) {
  console.log(`  ${message}`);
}

function findFile(dir, names) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const found = findFile(full, names);
      if (found) return found;
    } else if (names.includes(entry)) {
      return full;
    }
  }
  return null;
}

if (!existsSync(appMain)) {
  fail('android/ not found. Run `npm run build && npx cap add android` first.');
}

// ---- 1. Plugin source --------------------------------------------------------

const mainActivity = findFile(join(appMain, 'java'), ['MainActivity.java', 'MainActivity.kt']);
if (!mainActivity) fail('MainActivity.java/.kt not found under android/app/src/main/java.');

let activity = readFileSync(mainActivity, 'utf8');
const packageMatch = activity.match(/^\s*package\s+([\w.]+)\s*;?/m);
if (!packageMatch) fail(`no package declaration in ${mainActivity}`);
const packageName = packageMatch[1];

const pluginSource = readFileSync(join(nativeDir, `${PLUGIN}.java`), 'utf8').replace(
  /^package\s+[\w.]+;/m,
  `package ${packageName};`,
);
const pluginTarget = join(dirname(mainActivity), `${PLUGIN}.java`);
if (!existsSync(pluginTarget) || readFileSync(pluginTarget, 'utf8') !== pluginSource) {
  writeFileSync(pluginTarget, pluginSource);
  report(`copied ${PLUGIN}.java -> ${relative(repo, pluginTarget)}`);
} else {
  report(`${PLUGIN}.java already up to date`);
}

// ---- 2. Register in MainActivity --------------------------------------------

const isKotlin = mainActivity.endsWith('.kt');
const registerCall = isKotlin
  ? `registerPlugin(${PLUGIN}::class.java)`
  : `registerPlugin(${PLUGIN}.class);`;

if (activity.includes(`registerPlugin(${PLUGIN}`)) {
  report('MainActivity already registers the plugin');
} else {
  const indent = '        ';
  if (/super\.onCreate\s*\(/.test(activity)) {
    // An existing onCreate: register just before it calls super.
    activity = activity.replace(
      /^([ \t]*)super\.onCreate\s*\(/m,
      (_match, lineIndent) => `${lineIndent}${registerCall}\n${lineIndent}super.onCreate(`,
    );
  } else {
    const method = isKotlin
      ? `    override fun onCreate(savedInstanceState: Bundle?) {\n${indent}// Custom plugins must be registered before the bridge starts.\n${indent}${registerCall}\n${indent}super.onCreate(savedInstanceState)\n    }\n`
      : `    @Override\n    public void onCreate(Bundle savedInstanceState) {\n${indent}// Custom plugins must be registered before the bridge starts.\n${indent}${registerCall}\n${indent}super.onCreate(savedInstanceState);\n    }\n`;

    // `class MainActivity extends BridgeActivity {}` / `class MainActivity : BridgeActivity()`
    const emptyBody = /(class\s+MainActivity[^{\n]*?)\s*\{\s*\}/;
    const bodyOpen = /(class\s+MainActivity[^{\n]*\{)/;
    if (emptyBody.test(activity)) {
      activity = activity.replace(emptyBody, (_m, head) => `${head} {\n${method}}`);
    } else if (bodyOpen.test(activity)) {
      activity = activity.replace(bodyOpen, (head) => `${head}\n${method}`);
    } else if (isKotlin && /class\s+MainActivity\s*:\s*BridgeActivity\(\)[ \t]*$/m.test(activity)) {
      // Kotlin allows a class with no body at all.
      activity = activity.replace(
        /(class\s+MainActivity\s*:\s*BridgeActivity\(\))[ \t]*$/m,
        (_m, head) => `${head} {\n${method}}`,
      );
    } else {
      fail(`could not find the MainActivity class body in ${mainActivity}; add ${registerCall} before super.onCreate by hand.`);
    }

    if (!/import\s+android\.os\.Bundle/.test(activity)) {
      activity = activity.replace(
        /^(\s*package\s+[\w.]+\s*;?\s*\n)/m,
        `$1import android.os.Bundle${isKotlin ? '' : ';'}\n`,
      );
    }
  }
  writeFileSync(mainActivity, activity);
  report(`registered ${PLUGIN} in ${relative(repo, mainActivity)}`);
}

// ---- 3. Manifest -------------------------------------------------------------

const manifestPath = join(appMain, 'AndroidManifest.xml');
let manifest = readFileSync(manifestPath, 'utf8');
const additions = readFileSync(join(nativeDir, 'AndroidManifest.additions.xml'), 'utf8').replace(
  /<!--[\s\S]*?-->/g,
  '',
);
const before = manifest;

for (const tag of additions.match(/<uses-permission\b[^>]*\/>/g) ?? []) {
  const name = tag.match(/android:name="([^"]+)"/)?.[1];
  if (!name) continue;
  const normalised = tag.replace(/\s+/g, ' ');
  const existing = new RegExp(`[ \\t]*<uses-permission\\b[^>]*android:name="${name.replace(/\./g, '\\.')}"[^>]*/>[ \\t]*\\r?\\n?`, 'g');
  // Replace rather than skip, so an older line (e.g. without maxSdkVersion) is corrected.
  manifest = manifest.replace(existing, '');
  manifest = manifest.replace(/(\s*)<\/manifest>/, `\n    ${normalised}$1</manifest>`);
}

const applicationTag = additions.match(/<application\b([^>]*?)\/?>/);
if (applicationTag) {
  for (const [, attr, value] of applicationTag[1].matchAll(/([\w:]+)="([^"]*)"/g)) {
    manifest = manifest.replace(/<application\b[^>]*>/, (open) => {
      const pattern = new RegExp(`${attr}="[^"]*"`);
      return pattern.test(open)
        ? open.replace(pattern, `${attr}="${value}"`)
        : open.replace(/<application\b/, `<application\n        ${attr}="${value}"`);
    });
  }
}

// Collapse the blank lines the permission swaps can leave behind.
manifest = manifest.replace(/\n{3,}/g, '\n\n');

if (manifest !== before) {
  writeFileSync(manifestPath, manifest);
  report(`merged permissions and attributes into ${relative(repo, manifestPath)}`);
} else {
  report('AndroidManifest.xml already up to date');
}

console.log('apply-android-native: done. Next: npx cap sync android');
