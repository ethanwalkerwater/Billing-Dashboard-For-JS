import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';

const docs = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(docs, '../outputs/classroom-reports');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const mvpUrl = pathToFileURL(path.join(docs, 'MVP.html')).href;
  const reportUrl = pathToFileURL(path.join(docs, 'classroom-report.html')).href;
  const ids = ['xiaoyu', 'haoran', 'zihan', 'yinuo', 'haoran2', 'zihan2'];
  for (const id of ids) {
    await page.goto(`${reportUrl}?lesson=${id}`);
    assert.ok(await page.locator('section').count() >= 8);
    assert.equal(await page.locator('tbody tr').count(), 3);
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({ path: path.join(output, `${id}.pdf`), printBackground: true, preferCSSPageSize: true, tagged: true });
    const pdf = await PDFDocument.load(await readFile(path.join(output, `${id}.pdf`)));
    assert.ok(pdf.getPageCount() <= 3, `${id}: PDF should fit in three pages`);
    console.log(id, 'pages', pdf.getPageCount());
    const bytes = await readFile(path.join(output, `${id}.pdf`));
    await writeFile(path.join(output, `${id}.pdf.js`), `document.getElementById('download').href = 'data:application/pdf;base64,${bytes.toString('base64')}';\n`);
    await page.reload();
    const downloading = page.waitForEvent('download');
    await page.locator('#download').click();
    const download = await downloading;
    assert.equal(await download.failure(), null);
    assert.ok(download.suggestedFilename().endsWith('_课堂学情报告.pdf'));
    assert.deepEqual(await readFile(await download.path()), await readFile(path.join(output, `${id}.pdf`)));
  }
  await page.goto(mvpUrl);
  assert.equal(await page.locator('details').count(), 0);
  for (const id of ids.filter(id => id !== 'xiaoyu')) {
    await page.locator(`.row[data-id="${id}"]`).click();
    assert.equal(await page.locator('.report-cta a').getAttribute('href'), `classroom-report.html?lesson=${id}`);
  }
  await page.locator('.scene[data-s="5"]').click();
  await page.locator('.report-cta a').waitFor();
  assert.equal(await page.locator('.report-cta a').getAttribute('href'), 'classroom-report.html?lesson=xiaoyu');
  const popupReady = page.waitForEvent('popup');
  await page.locator('.report-cta a').click();
  const popup = await popupReady;
  await popup.waitForLoadState();
  assert.ok((await popup.title()).includes('小雨_IG 物理'));
  await popup.close();
  await page.locator('.scene[data-s="0"]').click();
  await page.locator('.report-cta').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'mvp-desktop.png') });
  await page.goto(`${reportUrl}?lesson=haoran`);
  await page.screenshot({ path: path.join(output, 'report-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'report-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(output, 'report-dark-mobile.png'), fullPage: true });
  await page.goto(mvpUrl);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, 'mvp-dark-mobile.png'), fullPage: true });
  for (const query of ['', '?lesson=unknown', '?lesson=chenxi', '?lesson=%3Cscript%3E']) {
    await page.goto(reportUrl + query);
    assert.equal(await page.locator('h1').textContent(), '未找到这份课堂报告');
    assert.equal(await page.locator('#download').isVisible(), false);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: six reports, CTA navigation, actual PDF downloads, at most three-page PDFs, mobile layouts, and invalid links.');
} finally {
  await browser.close();
}
