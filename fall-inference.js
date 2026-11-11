"use strict";

const gravity = 9.80665;

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function fallFeatures(window, edgeMs) {
  const start = window[0].time;
  const end = window.at(-1).time;
  const acceleration = window.map(({ values }) => values.slice(0, 3)
    .map((axis) => Math.max(-2, Math.min(2, axis / gravity))));
  const magnitude = acceleration.map((axes) => Math.hypot(...axes));
  const gyro = window.map(({ values }) => Math.hypot(...values.slice(3)));
  const head = window.findIndex(({ time }) => time >= start + edgeMs);
  const tail = window.findIndex(({ time }) => time >= end - edgeMs);
  if (head < 2 || tail < head || tail > window.length - 2) return null;

  const before = [0, 1, 2].map((axis) => mean(acceleration.slice(0, head).map((sample) => sample[axis])));
  const after = [0, 1, 2].map((axis) => mean(acceleration.slice(tail).map((sample) => sample[axis])));
  const dot = before.reduce((sum, axis, i) => sum + axis * after[i], 0);
  const denominator = Math.hypot(...before) * Math.hypot(...after);
  const cosine = denominator > 1e-6 ? Math.max(-1, Math.min(1, dot / denominator)) : 1;
  return [
    Math.min(...magnitude),
    Math.max(...magnitude),
    deviation(magnitude),
    deviation(magnitude.slice(tail)),
    Math.log1p(Math.max(...gyro)),
    Math.log1p(mean(gyro)),
    Math.log1p(mean(gyro.slice(tail))),
    1 - cosine,
  ];
}

function recentWindow(samples, windowMs) {
  const end = samples.at(-1)?.time;
  const start = end - windowMs;
  const first = samples.findIndex(({ time }) => time >= start);
  if (first < 0 || samples[first].time - start > 50) return null;

  const window = samples.slice(first);
  // Suppress stale or sparse windows after a stall or a cable interruption.
  if (window.length < windowMs * 0.04 || window.some(({ time }, i) => i > 0 && time - window[i - 1].time > 250)) {
    return null;
  }
  return window;
}

function fallScore(samples) {
  const window = recentWindow(samples, fallModel.windowMs);
  if (!window) return null;
  const features = fallFeatures(window, fallModel.edgeMs);
  if (!features) return null;

  const logit = features.reduce((sum, value, i) => {
    return sum + fallModel.weights[i] * (value - fallModel.center[i]) / fallModel.scale[i];
  }, fallModel.bias);
  return 1 / (1 + Math.exp(-logit));
}

function fallWithPostureChange(samples, score, threshold) {
  const moreSensitive = threshold <= 0.60;
  const minimumScore = moreSensitive ? 0.25 : 0.30;
  if (score === null || threshold >= fallModel.threshold) return false;
  const window = recentWindow(samples, 3000);
  if (!window) return false;

  const start = window[0].time;
  const end = window.at(-1).time;
  const before = window.filter(({ time }) => time < start + 500);
  const after = window.filter(({ time }) => time > end - 650);
  const motion = window.filter(({ time }) => time >= start + 500 && time <= end - 650);
  if (before.length < 15 || after.length < 20) return false;

  const impact = moreSensitive ? 1.8 : 2.0;
  const rotation = motion.filter(({ values }) => Math.hypot(...values.slice(3)) >= 100);
  const lowAcceleration = moreSensitive ? 0.60 : 0.52;
  const minimumLowAccelerationScore = moreSensitive ? 0.05 : 0.08;
  const hasFallMotion = motion.some(({ time, values }) => {
    const acceleration = Math.hypot(...values.slice(0, 3)) / gravity;
    const impactWithModelSupport = acceleration >= impact && score >= minimumScore;
    const lowAccelerationWithModelSupport = acceleration <= lowAcceleration && score >= minimumLowAccelerationScore;
    return (impactWithModelSupport || lowAccelerationWithModelSupport) &&
      rotation.some((sample) => Math.abs(sample.time - time) <= 400);
  });
  if (!hasFallMotion) return false;

  const afterGyroRms = Math.sqrt(mean(after.map(({ values }) => Math.hypot(...values.slice(3)) ** 2)));
  if (afterGyroRms > 15) return false;

  const averageVector = (segment) => [0, 1, 2].map((axis) => mean(segment.map(({ values }) => values[axis])));
  const from = averageVector(before);
  const to = averageVector(after);
  const fromLength = Math.hypot(...from);
  const toLength = Math.hypot(...to);
  if (Math.abs(fromLength - gravity) > 1.5 || Math.abs(toLength - gravity) > 1.5) return false;

  const cosine = from.reduce((sum, value, i) => sum + value * to[i], 0) / (fromLength * toLength);
  const minimumAngle = moreSensitive ? 35 : 40;
  return cosine <= Math.cos(minimumAngle * Math.PI / 180);
}
