import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localReleaseApk } from '../server/app-download.ts';

test('only offers a compiled release matching the required app version', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-apk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'app-release.apk');
  const metadataFile = path.join(dir, 'output-metadata.json');
  const metadata = { applicationId: 'dev.multicam.recorder', variantName: 'release',
    elements: [{ versionName: '0.6.2', outputFile: 'app-release.apk' }] };
  const write = (value) => fs.writeFileSync(metadataFile, JSON.stringify(value));
  assert.equal(localReleaseApk(dir, '0.6.2'), undefined, 'a checkout without APKs falls back to GitHub');
  write(metadata);
  assert.equal(localReleaseApk(dir, '0.6.2'), undefined, 'metadata alone does not make an update available');
  fs.writeFileSync(file, 'compiled signed release');
  assert.equal(localReleaseApk(dir, '0.6.2'), file);
  assert.equal(localReleaseApk(dir, '0.6.3'), undefined, 'an older local build must never be offered as the latest update');
  write({ ...metadata, variantName: 'debug' });
  assert.equal(localReleaseApk(dir, '0.6.2'), undefined, 'debug signing cannot update release installations');
  write({ ...metadata, applicationId: 'another.app' });
  assert.equal(localReleaseApk(dir, '0.6.2'), undefined);
  write({ ...metadata, elements: [{ versionName: '0.6.2', outputFile: '../other.apk' }] });
  assert.equal(localReleaseApk(dir, '0.6.2'), undefined, 'only the known release artifact can be exposed');
  fs.writeFileSync(metadataFile, '{broken');
  assert.equal(localReleaseApk(dir, '0.6.2'), undefined);
});
