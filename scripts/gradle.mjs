#!/usr/bin/env node
/**
 * Run the Android project's Gradle wrapper on any OS.
 *
 *   node scripts/gradle.mjs assembleDebug
 *
 * Windows needs `gradlew.bat`; macOS and Linux need `./gradlew`, which also
 * loses its executable bit when the repo is checked out on Windows first — so
 * it is restored here before running.
 */

import { chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const androidDir = join(process.cwd(), 'android');
const windows = process.platform === 'win32';
const wrapper = join(androidDir, windows ? 'gradlew.bat' : 'gradlew');

if (!existsSync(wrapper)) {
  console.error(`gradle: ${wrapper} not found. Run this from the repo root, on the App branch.`);
  process.exit(1);
}
if (!windows) chmodSync(wrapper, 0o755);

// .bat files need a shell on Windows, and the shell needs the path quoted
// (repo folders often contain spaces or parentheses).
const result = windows
  ? spawnSync(`"${wrapper}"`, process.argv.slice(2), { cwd: androidDir, stdio: 'inherit', shell: true })
  : spawnSync(wrapper, process.argv.slice(2), { cwd: androidDir, stdio: 'inherit' });
process.exit(result.status ?? 1);
