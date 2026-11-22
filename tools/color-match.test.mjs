import assert from 'node:assert/strict';
import test from 'node:test';
import { samplePixels, difference, matchControls } from '../server/public/color-match.js';

const capabilities = { exposureRange: [-2, 2], exposureStep: 1 / 3, manualWhiteBalance: true };
const controls = { exposureEv: 0, whiteBalance: 'auto', gains: [2, 1, 1, 2] };
const sample = (rgb) => ({ rgb, luma: rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 });
const pixels = (rgb) => Uint8ClampedArray.from(Array.from({ length: 64 }, () => [...rgb, 255]).flat());

test('samples in linear light, excluding clipped highlights and crushed shadows', () => {
  assert.ok(Math.abs(samplePixels(pixels([128, 128, 128])).luma - .21586) < .0001);
  assert.equal(samplePixels(pixels([255, 255, 255])), null);
  assert.equal(samplePixels(pixels([0, 0, 0])), null);
  assert.equal(samplePixels(pixels([255, 0, 0])), null);
  const mixed = new Uint8ClampedArray([...pixels([255, 255, 255]), ...pixels([128, 128, 128])]);
  assert.deepEqual(samplePixels(mixed), samplePixels(pixels([128, 128, 128])));
});

test('a neutral darker target receives positive, quantized exposure compensation', () => {
  const ref = sample([.4, .4, .4]);
  const target = sample([.2, .2, .2]);
  assert.equal(difference(ref, target).ev, 1);
  const next = matchControls(ref, target, controls, capabilities);
  assert.equal(next.exposureEv, 2 / 3);
  assert.deepEqual(next.gains, controls.gains);
  assert.deepEqual(controls.gains, [2, 1, 1, 2]);
});

test('warm / cool corrections reduce the colour error without copying reference gains', () => {
  const ref = sample([.3, .3, .3]);
  const target = sample([.4, .3, .2]);
  const next = matchControls(ref, target, controls, capabilities);
  assert.ok(next.gains[0] < controls.gains[0]);
  assert.ok(next.gains[3] > controls.gains[3]);
  const corrected = sample(target.rgb.map((v, i) => v * next.gains[[0, 1, 3][i]] / controls.gains[[0, 1, 3][i]]));
  assert.ok(Math.abs(difference(ref, corrected).red) < Math.abs(difference(ref, target).red));
  assert.ok(Math.abs(difference(ref, corrected).blue) < Math.abs(difference(ref, target).blue));
});

test('camera limits are respected; unsupported WB leaves its mode and gains intact', () => {
  const next = matchControls(sample([.7, .7, .7]), sample([.01, .01, .01]), { ...controls, exposureEv: 2 }, capabilities);
  assert.equal(next.exposureEv, 2);
  assert.ok(next.gains.every((g) => g >= 1 && g <= 8));
  const limited = matchControls(sample([.3, .3, .3]), sample([.1, .3, .5]), controls, { ...capabilities, manualWhiteBalance: false });
  assert.equal(limited.whiteBalance, 'auto');
  assert.deepEqual(limited.gains, controls.gains);
  const saturated = matchControls(sample([.7, .1, .1]), sample([.01, .2, .4]), { ...controls, gains: [8, 1, 1.2, 1] }, capabilities);
  assert.ok(saturated.gains.every((g) => g >= 1 && g <= 8));
});
