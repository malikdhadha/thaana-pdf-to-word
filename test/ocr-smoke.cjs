// Checks that the bundled Thaana model loads and reads a line, the same way main.js does.
//   node test/ocr-smoke.cjs test/fixtures/line.png
const path = require('path');
const { createWorker, PSM } = require('tesseract.js');
(async () => {
  const w = await createWorker('div', 1, { langPath: path.join(__dirname, '..', 'lang'), gzip: false, cacheMethod: 'none' });
  await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: '1' });
  const { data } = await w.recognize(process.argv[2]);
  console.log(JSON.stringify({ text: data.text.trim(), confidence: Math.round(data.confidence) }));
  await w.terminate();
})().catch((e) => { console.error('FAILED:', e.message || e); process.exit(1); });
