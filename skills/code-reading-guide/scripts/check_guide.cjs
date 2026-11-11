#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createRequire} = require('node:module');
const {checkReview} = require('./check_review.cjs');

async function main() {
  const args = process.argv.slice(2);
  if (!args[0] || args.includes('--help')) {
    process.stdout.write('Usage: node check_guide.cjs guide.html [--out artifact-directory]\nSet CODE_READING_PLAYWRIGHT to a Playwright module path if needed.\n');
    return;
  }
  const file = path.resolve(args[0]);
  const outputIndex = args.indexOf('--out');
  const output = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : file + '.check');
  let chromium;
  try {
    const load = createRequire(path.join(process.cwd(), 'package.json'));
    ({chromium} = load(process.env.CODE_READING_PLAYWRIGHT || 'playwright'));
  } catch {
    throw new Error('Playwright is unavailable. Set CODE_READING_PLAYWRIGHT to an installed module; static validation alone does not verify browser interactions.');
  }
  await fs.mkdir(output, {recursive:true});
  const browser = await chromium.launch({headless:true});
  const errors = [], externalRequests = [];
  function watch(page) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {if (/^https?:/.test(request.url())) externalRequests.push(request.url());});
  }
  const url = pathToFileURL(file).href;
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1100},offline:true});
    const page = await context.newPage();
    watch(page);
    await page.goto(url + '#overview');
    await page.waitForSelector('.flow-node');
    const data = await page.evaluate(() => JSON.parse(document.getElementById('guide-data').textContent));
    assert.equal(await page.locator('.flow-node').count(), data.overview.flow.length);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path:path.join(output,'overview-desktop.png'),fullPage:true});
    await page.locator('.flow-node').last().click();
    assert.ok((await page.locator('#flowDetail').innerText()).includes(data.overview.flow.at(-1).name));
    let references = 0;
    for (const block of data.blocks) {
      await page.goto(url + '#block/' + block.id);
      await page.waitForSelector(`[data-checkpoint="${block.id}"]`);
      assert.equal(await page.locator('.checkpoint').count(), 1);
      assert.equal(await page.locator('.source-entry[open]').count(), 0);
      assert.equal(await page.locator('.source-entry').count(), block.refs.length);
      for (let index = 0; index < block.refs.length; index++) {
        const reference = block.refs[index];
        const entry = page.locator('.source-entry').nth(index);
        await entry.locator(':scope > summary').click();
        assert.equal(await page.locator('.source-entry[open]').count(), 1);
        assert.equal(await entry.locator('.source-intro .io > div').count(), 3);
        assert.equal(await entry.locator('.source-example').isVisible(), true);
        assert.equal(await entry.locator('.line-notes > li').count(), reference.steps.length);
        const sourceLines = data.sources[reference.source].lines;
        const rendered = await entry.locator('.code-row').evaluateAll(rows => rows.map(row => Array.from(row.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('')));
        assert.deepEqual(rendered, sourceLines.slice(reference.start - 1, reference.end));
        await entry.locator('.source-check > summary').click();
        assert.ok((await entry.locator('.source-check p').innerText()).length > 0);
        for (let step = 0; step < reference.steps.length; step++) {
          await entry.locator('.line-notes button').nth(step).click();
          assert.equal(await page.locator('#sourceDialog').evaluate(dialog => dialog.open), true);
          const range = reference.steps[step];
          assert.equal(await page.locator('#sourceCode .highlight').count(), range.end - range.start + 1);
          assert.equal(await page.locator('#sourceCode .highlight').first().getAttribute('data-line'), String(range.start));
          await page.keyboard.press('Escape');
        }
        await entry.locator(':scope > summary').click();
        references++;
      }
      const wrong = (block.checkpoint.answer + 1) % block.checkpoint.choices.length;
      await page.locator(`input[name=checkpoint][value="${wrong}"]`).check();
      await page.locator('[data-action=check]').click();
      assert.equal(await page.locator('#feedback .wrong').count(), 1);
      assert.ok((await page.locator('#feedback').innerText()).includes(block.checkpoint.simpler));
      await page.locator(`input[name=checkpoint][value="${block.checkpoint.answer}"]`).check();
      await page.locator('[data-action=check]').click();
      assert.equal(await page.locator('#feedback .wrong').count(), 0);
      assert.ok((await page.locator('#feedback').innerText()).includes(block.checkpoint.explanation));
      assert.equal(page.url(), url + '#block/' + block.id, 'Answering must not auto-advance');
      await page.locator('textarea[data-note]').fill('我的解释：输入 → 输出。<script>这只是笔记文本</script>');
      await page.reload();
      assert.match(await page.locator('textarea[data-note]').inputValue(), /输入 → 输出/);
    }
    assert.equal(await page.locator('#progressText').innerText(), `${data.blocks.length} / ${data.blocks.length}`);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.topbar [data-action=export]').click();
    const download = await downloadPromise;
    const progressPath = path.join(output,'progress.json');
    await download.saveAs(progressPath);
    const progress = JSON.parse(await fs.readFile(progressPath,'utf8'));
    assert.equal(progress.fingerprint, data.fingerprint);
    assert.equal(progress.blocks.length, data.blocks.length);
    assert.ok(progress.blocks.every(block => block.understood && block.note.includes('输入 → 输出')));
    await page.goto(url + '#trace');
    for (let index = 0; index < data.trace.length; index++) {
      await page.locator(`.trace-index [data-trace="${index}"]`).click();
      assert.ok((await page.locator('#tracePanel').innerText()).includes(data.trace[index].output));
    }
    await page.goto(url + '#maintenance');
    assert.equal(await page.locator('.evidence').count(), data.evidence.length);
    await page.goto(url + '#block/' + data.blocks[0].id);
    await page.locator('.source-entry > summary').first().click();
    await page.screenshot({path:path.join(output,'block-desktop.png'),fullPage:true});
    assert.equal(await page.evaluate(() => globalThis.__guideInjection), undefined);

    const mobileContext = await browser.newContext({viewport:{width:390,height:844},isMobile:true,offline:true});
    const mobile = await mobileContext.newPage();
    watch(mobile);
    await mobile.goto(url + '#overview');
    await mobile.waitForSelector('.flow-node');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobile.screenshot({path:path.join(output,'overview-mobile.png'),fullPage:true});
    await mobile.locator('#mobileBlock').selectOption(data.blocks[0].id);
    await mobile.waitForSelector('.source-entry');
    await mobile.locator('.source-entry > summary').first().click();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobile.screenshot({path:path.join(output,'block-mobile.png'),fullPage:true});

    const blockedContext = await browser.newContext({offline:true});
    await blockedContext.addInitScript(() => Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage denied','SecurityError');}}));
    const blocked = await blockedContext.newPage();
    watch(blocked);
    await blocked.goto(url + '#block/' + data.blocks[0].id);
    await blocked.waitForSelector('.checkpoint');
    assert.equal(await blocked.locator('#storageNotice').isVisible(), true);
    await blocked.locator('textarea').fill('没有持久化存储也可继续学习。');
    const blockedDownloadPromise = blocked.waitForEvent('download');
    await blocked.locator('.topbar [data-action=export]').click();
    const blockedDownload = await blockedDownloadPromise;
    await blockedDownload.saveAs(path.join(output,'progress-storage-blocked.json'));
    const blockedProgress = JSON.parse(await fs.readFile(path.join(output,'progress-storage-blocked.json'),'utf8'));
    assert.match(blockedProgress.blocks[0].note, /没有持久化存储/);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    const reviewReport = data.review?.enabled ? await checkReview({chromium,file,output:path.join(output,'review')}) : null;
    const report = {ok:true,review:reviewReport,blocks:data.blocks.length,explainedSourceReferences:references,traceSteps:data.trace.length,fingerprint:data.fingerprint,checks:['offline loading','exact source text and line links','one block and one expanded source at a time','wrong/correct feedback without auto-advance','notes and progress persistence','progress export','data journey','evidence view','desktop/mobile layout','storage-denied fallback and export','zero external requests','zero page errors']};
    await fs.writeFile(path.join(output,'browser-check.json'),JSON.stringify(report,null,2)+'\n');
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
  } finally {
    await browser.close();
  }
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
