import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBuilds } from '../src/find-build.js';

/** A project folder with these files; each gets an mtime (seconds) so "newest first" is testable. */
async function project(files: Record<string, number>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'release-lint-find-'));
  for (const [path, seconds] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), 'x');
    await utimes(join(root, path), seconds, seconds);
  }
  return root;
}

describe('findBuilds', () => {
  it('finds release builds in the usual output folders, newest first', async () => {
    const root = await project({
      'build-1732540000.aab': 100,
      'MyApp.ipa': 300,
      'build/MyApp.ipa': 150,
      'ios/build/MyApp.ipa': 120,
      'android/app/build/outputs/bundle/release/app-release.aab': 200,
      'android/app/build/outputs/apk/release/app-release.apk': 250,
      'android/app/build/outputs/bundle/productionRelease/app-production-release.aab': 400,
    });
    expect((await findBuilds(root)).map((b) => b.path)).toEqual([
      'android/app/build/outputs/bundle/productionRelease/app-production-release.aab',
      'MyApp.ipa',
      'android/app/build/outputs/apk/release/app-release.apk',
      'android/app/build/outputs/bundle/release/app-release.aab',
      'build/MyApp.ipa',
      'ios/build/MyApp.ipa',
      'build-1732540000.aab',
    ]);
  });

  it('skips debug outputs, node_modules, other file types and folders named like apps', async () => {
    const root = await project({
      'android/app/build/outputs/apk/debug/app-debug.apk': 100,
      'android/app/build/outputs/bundle/stagingDebug/app-staging-debug.aab': 100,
      'node_modules/some-lib/fixture.apk': 100,
      'src/test-fixture.ipa': 100,
      'app.json': 100,
      'notes.aab.txt': 100,
    });
    await mkdir(join(root, 'Folder.ipa'));
    expect(await findBuilds(root)).toEqual([]);
  });

  it('finds flavored APKs, which Gradle puts one folder deeper (apk/<flavor>/release/), but not their debug builds', async () => {
    const root = await project({
      'android/app/build/outputs/apk/production/release/app-production-release.apk': 200,
      'android/app/build/outputs/apk/production/debug/app-production-debug.apk': 300,
      'android/app/build/outputs/apk/staging/release/app-staging-release.apk': 100,
    });
    expect((await findBuilds(root)).map((b) => b.path)).toEqual([
      'android/app/build/outputs/apk/production/release/app-production-release.apk',
      'android/app/build/outputs/apk/staging/release/app-staging-release.apk',
    ]);
  });

  it('returns nothing for a folder that does not exist', async () => {
    expect(await findBuilds(join(tmpdir(), 'release-lint-missing-folder-xyz'))).toEqual([]);
  });
});
