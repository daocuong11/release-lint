import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ReleaseLintError, type AppModel } from '../types.js';
import { AAB_MANIFEST, APK_MANIFEST, readAab, readApk } from './android.js';
import { isAppFolderName, openAppFolder } from './folder.js';
import { readIpa } from './ios.js';
import { openZip, type ArchiveEntry, type ZipArchive } from './zip.js';

const PAYLOAD = 'Payload/';
/** `Demo.app/Info.plist` at the root of a zip: a zipped .app without the Payload/ folder of a real .ipa. */
const ROOT_APP_INFO = /^[^/]+\.app\/Info\.plist$/;

/** Opens a built app (.ipa, .aab, .apk, or an iOS .app / .xcarchive folder), detects the platform and reads the app model. */
export async function readApp(path: string): Promise<AppModel> {
  const file = basename(path);
  if ((await stat(path)).isDirectory()) {
    if (!isAppFolderName(file)) {
      throw new ReleaseLintError(`${file} is a directory: give an .ipa, .aab or .apk file, or an iOS .app or .xcarchive folder`);
    }
    // Xcode signs the app again on export, so its signing here is not what ships.
    return readIpa(await openAppFolder(path), file, { exported: false });
  }
  const zip = await openZip(path);
  try {
    const names = [...zip.entries.keys()];
    if (names.some((name) => name.startsWith(PAYLOAD))) {
      return await readIpa(zip, file);
    }
    if (zip.entries.has(AAB_MANIFEST)) {
      return await readAab(zip, file);
    }
    if (zip.entries.has(APK_MANIFEST)) {
      return await readApk(zip, file);
    }
    if (names.some((name) => ROOT_APP_INFO.test(name))) {
      return await readIpa(underPayload(zip), file);
    }
    throw new ReleaseLintError(`Not an .ipa, .aab or .apk file: no ${PAYLOAD}<App>.app/, ${APK_MANIFEST} or ${AAB_MANIFEST} inside`);
  } finally {
    await zip.close();
  }
}

/** The same archive seen with every entry under Payload/, so the .ipa reader works unchanged (Mattermost's unsigned .ipa). */
function underPayload(zip: ZipArchive): ZipArchive {
  const entries = new Map<string, ArchiveEntry>([...zip.entries].map(([name, entry]) => [PAYLOAD + name, { ...entry, name: PAYLOAD + name }]));
  return {
    entries,
    read: (name, maxBytes) => {
      if (!entries.has(name)) throw new ReleaseLintError(`No ${name} in the archive`);
      return zip.read(name.slice(PAYLOAD.length), maxBytes);
    },
    close: () => zip.close(),
  };
}
