// lib/cnn.js — معماری مشترک CNN کاراکتر (آموزش و استنتاج یکسان).
// TensorFlow.js: پیاده‌سازی بهینه کانولوشن که برای تصاویر کوچک عالی عمل می‌کند.
// اگر tfjs نصب نباشد، require خطا می‌دهد و فراخوان‌گر به مدل MLP برمی‌گردد.

let _tf;
function getTf() {
  if (!_tf) _tf = require('@tensorflow/tfjs');
  return _tf;
}

/**
 * CNN کوچک برای کاراکتر ۲۰×۲۰:
 * conv16(3×3,relu) → pool2 → conv32(3×3,relu) → pool2 → flatten → dense64 → softmax
 */
function buildCharCNN(numClasses) {
  const t = getTf();
  const m = t.sequential();
  m.add(t.layers.conv2d({ inputShape: [20, 20, 1], filters: 16, kernelSize: 3, padding: 'same', activation: 'relu' }));
  m.add(t.layers.maxPooling2d({ poolSize: 2 }));
  m.add(t.layers.conv2d({ filters: 32, kernelSize: 3, padding: 'same', activation: 'relu' }));
  m.add(t.layers.maxPooling2d({ poolSize: 2 }));
  m.add(t.layers.flatten());
  m.add(t.layers.dense({ units: 64, activation: 'relu' }));
  m.add(t.layers.dense({ units: numClasses, activation: 'softmax' }));
  return m;
}

module.exports = { buildCharCNN, getTf };
