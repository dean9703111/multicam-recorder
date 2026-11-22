import fs from 'node:fs';
import path from 'node:path';

// Only offer the release artifact when Gradle identifies it as the version this server expects.
// Debug APKs have a different signing key and must never be offered as an update.
export function localReleaseApk(dir: string, version: string): string | undefined {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'output-metadata.json'), 'utf8'));
    if (metadata.applicationId !== 'dev.multicam.recorder' || metadata.variantName !== 'release' || !Array.isArray(metadata.elements)) return;
    const artifact = metadata.elements.find((item: Record<string, unknown>) => item?.versionName === version && item.outputFile === 'app-release.apk');
    const file = path.join(dir, 'app-release.apk');
    if (artifact && fs.statSync(file).isFile() && fs.statSync(file).size > 0) return file;
  } catch {
    // An ordinary source checkout has no compiled APK; use GitHub Releases instead.
  }
}
