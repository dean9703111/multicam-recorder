// Small, pure helpers shared by the dashboard and the calibration checks.
export const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const linear = (v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

// Exclude crushed shadows and clipped highlights: neither contains useful colour information.
export function samplePixels(rgba) {
  const rgb = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const p = [rgba[i], rgba[i + 1], rgba[i + 2]];
    if (rgba[i + 3] < 250 || Math.min(...p) < 12 || Math.max(...p) > 243) continue;
    for (let c = 0; c < 3; c++) rgb[c] += linear(p[c] / 255);
    count++;
  }
  if (count < rgba.length / 4 * 0.25 || count < 16) return null;
  const mean = rgb.map((x) => x / count);
  return { rgb: mean, luma: mean[0] * 0.2126 + mean[1] * 0.7152 + mean[2] * 0.0722 };
}

export function difference(reference, target) {
  return {
    ev: Math.log2(reference.luma / target.luma),
    red: Math.log2((reference.rgb[0] / reference.rgb[1]) / (target.rgb[0] / target.rgb[1])),
    blue: Math.log2((reference.rgb[2] / reference.rgb[1]) / (target.rgb[2] / target.rgb[1])),
  };
}

// A damped correction: different phones apply different tone curves, so do not promise a colourimetric match.
export function matchControls(reference, target, controls, capabilities) {
  const delta = difference(reference, target);
  const step = capabilities.exposureStep;
  const [min, max] = capabilities.exposureRange;
  const exposureEv = clamp(Math.round((controls.exposureEv + clamp(delta.ev * 0.65, -1, 1)) / step) * step, min, max);
  let gains = [...controls.gains];
  if (capabilities.manualWhiteBalance) {
    gains[0] *= 2 ** clamp(delta.red * 0.65, -0.5, 0.5);
    gains[3] *= 2 ** clamp(delta.blue * 0.65, -0.5, 0.5);
    // Gain ratios determine chromaticity. Normalize upward to Camera2's minimum of 1.
    const scale = Math.max(1, 1 / Math.min(...gains));
    gains = gains.map((g) => clamp(g * scale, 1, 8));
  }
  return { exposureEv, whiteBalance: capabilities.manualWhiteBalance ? 'manual' : controls.whiteBalance, gains };
}
