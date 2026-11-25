import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const APP_FILE = /\.(ipa|aab|apk)$/i;
/** Where `eas build --local`, fastlane and Xcode exports usually put the file. */
const FLAT_FOLDERS = ['.', 'build', 'ios/build'];
/**
 * Gradle writes one folder per variant here; only release variants count. Bundles use one level
 * (`bundle/productionRelease/`), APKs with product flavors use two (`apk/production/release/`).
 */
const GRADLE_OUTPUTS = ['android/app/build/outputs/bundle', 'android/app/build/outputs/apk'];
const RELEASE_VARIANT = /release$/i;

/** For the "none found" message. */
export const SEARCHED_FOLDERS = [...FLAT_FOLDERS, ...GRADLE_OUTPUTS.map((folder) => `${folder}/*release`), 'android/app/build/outputs/apk/*/release'];

export interface Build {
  /** Relative to the project folder, with `/` separators. */
  path: string;
  modifiedMs: number;
}

/** Release builds in the usual output folders of a project, newest first. Never walks the tree, so node_modules is never read. */
export async function findBuilds(cwd: string): Promise<Build[]> {
  const firstLevel = (await Promise.all(GRADLE_OUTPUTS.map((folder) => subfolders(cwd, folder)))).flat();
  const secondLevel = (await Promise.all(firstLevel.filter((f) => !RELEASE_VARIANT.test(f)).map((folder) => subfolders(cwd, folder)))).flat();
  const variantFolders = [...firstLevel, ...secondLevel].filter((f) => RELEASE_VARIANT.test(f));
  const folders = [...FLAT_FOLDERS, ...variantFolders];
  const paths = (await Promise.all(folders.map((folder) => appFilesIn(cwd, folder)))).flat();
  const builds = await Promise.all(paths.map(async (path) => ({ path, modifiedMs: (await stat(join(cwd, path))).mtimeMs })));
  return builds.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

async function entries(cwd: string, folder: string) {
  try {
    return await readdir(join(cwd, folder), { withFileTypes: true });
  } catch {
    return []; // A missing or unreadable folder just has no builds.
  }
}

const childPath = (folder: string, name: string) => (folder === '.' ? name : `${folder}/${name}`);

async function subfolders(cwd: string, folder: string): Promise<string[]> {
  return (await entries(cwd, folder)).filter((e) => e.isDirectory()).map((e) => childPath(folder, e.name));
}

async function appFilesIn(cwd: string, folder: string): Promise<string[]> {
  return (await entries(cwd, folder)).filter((e) => e.isFile() && APP_FILE.test(e.name)).map((e) => childPath(folder, e.name));
}
