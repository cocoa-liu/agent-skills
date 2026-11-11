#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {createRequire} = require('node:module');
const {checkAlignment} = require('./check_alignment.cjs');
const {checkPositions} = require('./check_positions.cjs');

async function checkReview({chromium,file,output}) {
  await fs.mkdir(output,{recursive:true});
  const document = await fs.readFile(file,'utf8');
  const match=document.match(/<script id="guide-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match,'Guide must embed its source payload');
  const data=JSON.parse(match[1]),review=data.review;
  if(!review?.enabled)return {skipped:true,reason:'No base comparison in this guide'};
  const candidates=review.files.filter(file=>file.units>=2).sort((a,b)=>a.units-b.units);
  if(!candidates.length)return {skipped:true,reason:'Review behavior test requires two changed lines'};
  const chosen=candidates[0],units=chosen.hunks.flatMap(hunk=>hunk.rows).filter(row=>row.id);
  const [first,second]=units;
  const profile=await fs.mkdtemp(path.join(output,'browser-profile-'));
  const copy=path.join(output,'review-copy.html');
  await fs.writeFile(copy,document);
  const url=pathToFileURL(copy).href+'#review';
  const errors=[],network=[];
  const watch=page=>{page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))network.push(request.url());});};
  const row=(page,id)=>page.locator(`[data-review-row="${id}"]`);
  const status=async(page,id,value)=>{
    await page.locator('[data-review-action=clear-selection]').click();
    await page.locator(`[data-review-select="${id}"]`).check();
    await page.locator(`[data-review-mark="${value}"]`).click();
  };
  const backupAction=async(page,action)=>{const menu=page.locator('.rv-backup-menu');if(!await menu.evaluate(element=>element.open))await menu.locator('summary').click();await page.locator(`[data-review-action="${action}"]`).click();};
  const noteText='需要确认这个边界。\n<script>globalThis.reviewInjected = true</script>';
  let context,browser;
  try {
    context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1440,height:1100},offline:true});
    let page=await context.newPage();watch(page);
    await page.goto(url);await page.waitForSelector('.pr-review');
    assert.equal(await page.locator('.rv-file-button').count(),review.files.length);
    const frame=await page.locator('.pr-review').boundingBox();
    assert.ok(frame.width>1350,'Review should use the full desktop width');
    const folders=page.locator('[data-review-folder]');
    if(await folders.count()){
      const folder=folders.first();
      await folder.locator(':scope > summary').click();
      assert.equal(await folder.evaluate(element=>element.open),false);
      await page.locator('[data-review-filter]').fill(chosen.path);
      assert.ok(await page.locator(`[data-review-file="${chosen.id}"]`).isVisible());
      await page.locator('[data-review-filter]').fill('');
      const closed=page.locator('[data-review-folder]:not([open])');
      if(await closed.count())await closed.first().locator(':scope > summary').click();
    }
    const beforeWidth=(await page.locator('.rv-main').boundingBox()).width;
    await page.locator('[data-review-action=toggle-tree]').click();
    await page.locator('[data-review-action=toggle-notes]').click();
    assert.ok((await page.locator('.rv-main').boundingBox()).width>beforeWidth+400);
    await page.locator('[data-review-action=toggle-tree]').click();
    await page.locator('[data-review-action=toggle-notes]').click();
    await page.locator(`[data-review-file="${chosen.id}"]`).click();
    assert.equal(await page.locator('[data-review-row]').count(),chosen.units);
    const codeBox=await page.locator('.rv-main').boundingBox(),notesBox=await page.locator('.rv-notes').boundingBox();
    assert.ok(notesBox.x>=codeBox.x+codeBox.width,'Annotations belong in a separate right panel');
    assert.equal(await row(page,first.id).locator('.rv-code').evaluate(element=>getComputedStyle(element).whiteSpace),'pre');
    await page.locator('[data-review-action=toggle-wrap]').click();
    assert.equal(await row(page,first.id).locator('.rv-code').evaluate(element=>getComputedStyle(element).whiteSpace),'pre-wrap');
    await page.locator('[data-review-action=toggle-wrap]').click();
    for(const file of review.files){
      await page.locator(`[data-review-file="${file.id}"]`).click();
      const actual=await page.locator('.rv-code code').allTextContents();
      assert.deepEqual(actual,file.hunks.flatMap(hunk=>hunk.rows.map(row=>row.text)),file.path+' source text must survive highlighting');
    }
    const pythonFile=review.files.find(file=>file.path.endsWith('.py')&&file.hunks.some(hunk=>hunk.rows.some(row=>/\b(def|class|import)\b/.test(row.text))));
    if(pythonFile){await page.locator(`[data-review-file="${pythonFile.id}"]`).click();assert.ok(await page.locator('.rv-code .hljs-keyword').count()>0);}
    await page.locator(`[data-review-file="${chosen.id}"]`).click();
    assert.equal(await page.locator('[data-reading-status=unread]').count(),chosen.units);
    // A real mouse drag should select changed code rows without individual checkbox clicks.
    const dense=review.files.find(file=>file.hunks.some(hunk=>hunk.rows.filter(row=>row.id).length>=6))||chosen;
    await page.locator(`[data-review-file="${dense.id}"]`).click();
    const denseRows=dense.hunks.flatMap(hunk=>hunk.rows).filter(row=>row.id);
    const dragRows=denseRows.slice(0,Math.min(4,denseRows.length));
    const firstCode=page.locator(`[data-review-row="${dragRows[0].id}"] .rv-code`);
    const lastCode=page.locator(`[data-review-row="${dragRows.at(-1).id}"] .rv-code`);
    await firstCode.scrollIntoViewIfNeeded();await lastCode.scrollIntoViewIfNeeded();
    await page.locator('.rv-diff-scroll').evaluate(element=>element.scrollLeft=0);
    const a=await firstCode.boundingBox(),b=await lastCode.boundingBox();
    await page.mouse.move(a.x+8,a.y+a.height/2);await page.mouse.down();
    await page.mouse.move(b.x+Math.min(80,b.width-4),b.y+b.height/2,{steps:12});await page.mouse.up();
    await page.waitForFunction(count=>document.querySelectorAll('[data-review-select]:checked').length===count,dragRows.length);
    assert.deepEqual(await page.locator('[data-review-select]:checked').evaluateAll(nodes=>nodes.map(node=>node.dataset.reviewSelect)),dragRows.map(row=>row.id));
    assert.ok((await page.evaluate(()=>getSelection().toString())).length>0,'Dragging must still support copying source text');
    await page.locator('[data-review-mark=question]').click();
    for(const entry of dragRows)assert.equal(await row(page,entry.id).getAttribute('data-reading-status'),'question');
    for(const entry of denseRows.slice(dragRows.length))assert.equal(await row(page,entry.id).getAttribute('data-reading-status'),'unread');
    await page.locator('[data-review-action=select-file]').click();await page.locator('[data-review-mark=unread]').click();
    // Append a second, disjoint drag without losing an existing selection.
    await page.locator(`[data-review-select="${denseRows.at(-1).id}"]`).click();
    await page.locator('.rv-diff-scroll').evaluate(element=>{element.scrollTop=0;element.scrollLeft=0;});
    const appendStart=await firstCode.boundingBox(),appendEnd=await lastCode.boundingBox();
    await page.keyboard.down('Control');
    await page.mouse.move(appendStart.x+8,appendStart.y+appendStart.height/2);await page.mouse.down();
    await page.mouse.move(appendEnd.x+Math.min(80,appendEnd.width-4),appendEnd.y+appendEnd.height/2,{steps:12});await page.mouse.up();
    await page.keyboard.up('Control');
    const appended=[...new Set([...dragRows.map(row=>row.id),denseRows.at(-1).id])];
    await page.waitForFunction(count=>document.querySelectorAll('[data-review-select]:checked').length===count,appended.length);
    assert.deepEqual(await page.locator('[data-review-select]:checked').evaluateAll(nodes=>nodes.map(node=>node.dataset.reviewSelect)),appended);
    await page.locator(`[data-review-file="${chosen.id}"]`).click();
    const selectRange=async(side,start,end,append=false)=>{
      const menu=page.locator('.rv-range-menu');if(!await menu.evaluate(element=>element.open))await menu.locator('summary').click();
      await page.locator('[data-review-range-side]').selectOption(side);
      await page.locator('[data-review-range-start]').fill(String(start));await page.locator('[data-review-range-end]').fill(String(end));
      await page.locator('[data-review-range-append]').setChecked(append);
      await page.locator('[data-review-range-form] button[type=submit]').click();
    };
    const side=first.new!==null?'new':'old',line=first[side];
    await selectRange(side,line,line);
    const rangeExpected=units.filter(row=>row[side]===line).map(row=>row.id);
    assert.deepEqual(await page.locator('[data-review-select]:checked').evaluateAll(nodes=>nodes.map(node=>node.dataset.reviewSelect)),rangeExpected);
    await selectRange(second.new!==null?'new':'old',second.new??second.old,second.new??second.old,true);
    assert.equal(await page.locator('[data-review-select]:checked').count(),new Set([...rangeExpected,second.id]).size);
    await selectRange(side,999999,999999);
    assert.match(await page.locator('[data-review-range-message]').innerText(),/没有/);
    assert.equal(await page.locator('[data-review-select]:checked').count(),new Set([...rangeExpected,second.id]).size);
    await page.locator('.rv-range-menu > summary').click();
    await page.locator('[data-review-action=clear-selection]').click();

    assert.equal(await row(page,first.id).evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(238, 240, 242)');
    assert.equal(await row(page,first.id).locator('.rv-code').evaluate(element=>getComputedStyle(element).backgroundColor),'rgba(0, 0, 0, 0)');
    await page.locator(`[data-review-select="${first.id}"]`).click();
    await page.locator(`[data-review-select="${units.at(-1).id}"]`).click({modifiers:['Shift']});
    assert.equal(await page.locator('[data-review-select]:checked').count(),chosen.units);
    await page.locator('[data-review-action=clear-selection]').click();
    await page.locator('[data-review-action=select-file]').click();
    await page.locator('[data-review-mark=understood]').click();
    assert.equal(await page.locator('[data-reading-status=understood]').count(),chosen.units);
    assert.equal(await row(page,first.id).evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(225, 242, 229)');
    await status(page,second.id,'question');
    assert.equal(await row(page,second.id).evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(255, 241, 191)');
    await page.locator(`[data-review-note-toggle="${second.id}"]`).click();
    assert.equal(await page.locator(`[data-review-note="${second.id}"]`).evaluate(element=>element.getBoundingClientRect().height),22,'A new empty annotation should occupy one line');
    await page.locator(`[data-review-note="${second.id}"]`).fill(noteText);
    await page.locator(`[data-review-note-toggle="${first.id}"]`).click();
    const firstNote='第一处批注：默认展开全部内容。\n第二行\n第三行\n第四行\n第五行\n第六行：末尾不能被截断。';
    await page.locator(`[data-review-note="${first.id}"]`).fill(firstNote);
    await page.locator(`[data-review-note="${first.id}"]`).pressSequentially('继续写。');
    assert.equal(await page.locator(`[data-review-note="${first.id}"]`).inputValue(),firstNote+'继续写。');
    assert.equal(await page.locator(`[data-review-note="${second.id}"]`).inputValue(),noteText);
    assert.equal(await page.locator('[data-review-note-count]').innerText(),'2');
    assert.equal(await page.locator('[data-review-note-list] details').count(),0,'All note cards must be expanded by default');
    for(const id of [first.id,second.id])assert.ok(await page.locator(`[data-review-note="${id}"]`).evaluate(element=>element.clientHeight>=element.scrollHeight-1),'Full note text must fit without clipping');

    assert.match(await page.locator('[data-review-save-state]').innerText(),/已自动保存/);
    assert.equal(await row(page,first.id).getAttribute('data-reading-status'),'understood');
    assert.equal(await row(page,second.id).getAttribute('data-reading-status'),'question');
    await page.reload();await page.waitForSelector('[data-review-row]');
    assert.equal(await row(page,second.id).getAttribute('data-reading-status'),'question');
    assert.equal(await page.locator(`[data-review-note="${first.id}"]`).inputValue(),firstNote+'继续写。');
    assert.equal(await page.locator(`[data-review-note="${second.id}"]`).inputValue(),noteText);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:path.join(output,'review-desktop.png'),fullPage:false});

    // Change teaching metadata at the same URL: only the code snapshot should own review marks.
    const revised={...data,review_test_teaching_update:'New explanation; unchanged source'};
    const encoded=JSON.stringify(revised).replace(/</g,'\\u003c').replace(/&/g,'\\u0026');
    await fs.writeFile(copy,document.replace(match[1],()=>encoded));
    await page.reload();await page.waitForSelector('[data-review-row]');
    assert.equal(await row(page,first.id).getAttribute('data-reading-status'),'understood');
    await context.close();context=null;
    context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1440,height:1100},offline:true});
    page=await context.newPage();watch(page);await page.goto(url);await page.waitForSelector('[data-review-row]');
    assert.equal(await row(page,first.id).getAttribute('data-reading-status'),'understood');
    assert.equal(await row(page,second.id).getAttribute('data-reading-status'),'question');
    assert.equal(await page.locator(`[data-review-note="${second.id}"]`).inputValue(),noteText);

    const exportPromise=page.waitForEvent('download');
    await backupAction(page,'export');
    const exported=await exportPromise,backupPath=path.join(output,'review-progress.json');
    await exported.saveAs(backupPath);
    const backup=JSON.parse(await fs.readFile(backupPath,'utf8'));
    assert.equal(backup.snapshot_id,review.id);
    assert.equal(backup.entries[second.id].note,noteText);
    const htmlPromise=page.waitForEvent('download');
    await backupAction(page,'save-html');
    const htmlDownload=await htmlPromise,htmlPath=path.join(output,'marked-guide.html');
    await htmlDownload.saveAs(htmlPath);
    assert.ok((await fs.readFile(htmlPath,'utf8')).includes('pr-review-saved-progress'));
    await context.close();context=null;

    browser=await chromium.launch({headless:true});
    const fresh=await browser.newContext({offline:true});
    const imported=await fresh.newPage();watch(imported);await imported.goto(url);await imported.waitForSelector('.pr-review');
    await imported.locator(`[data-review-file="${chosen.id}"]`).click();
    assert.equal(await row(imported,first.id).getAttribute('data-reading-status'),'unread');
    await imported.locator('[data-review-import-file]').setInputFiles(backupPath);
    await imported.waitForFunction(id=>document.querySelector(`[data-review-row="${id}"]`)?.dataset.readingStatus==='question',second.id);
    assert.equal(await imported.locator(`[data-review-note="${second.id}"]`).inputValue(),noteText);
    const wrongPath=path.join(output,'wrong-snapshot.json');
    await fs.writeFile(wrongPath,JSON.stringify({...backup,snapshot_id:'another-code-snapshot'}));
    await imported.locator('[data-review-import-file]').setInputFiles(wrongPath);
    await imported.waitForFunction(()=>document.querySelector('[data-review-save-state]').textContent.includes('导入失败'));
    assert.equal(await row(imported,first.id).getAttribute('data-reading-status'),'understood');
    assert.equal(await row(imported,second.id).getAttribute('data-reading-status'),'question');
    // A valid row followed by a malformed row must not partially apply either.
    const invalidPath=path.join(output,'invalid-progress.json');
    await fs.writeFile(invalidPath,JSON.stringify({...backup,entries:{[first.id]:{...backup.entries[first.id],status:'unread'},[second.id]:{...backup.entries[second.id],status:['understood']}}}));
    await imported.locator('[data-review-import-file]').setInputFiles(invalidPath);
    await imported.waitForFunction(()=>document.querySelector('[data-review-save-state]').textContent.includes('无效代码行'));
    assert.equal(await row(imported,first.id).getAttribute('data-reading-status'),'understood');
    assert.equal(await row(imported,second.id).getAttribute('data-reading-status'),'question');
    await status(imported,first.id,'unread');await imported.reload();await imported.waitForSelector('[data-review-row]');
    assert.equal(await row(imported,first.id).getAttribute('data-reading-status'),'unread');
    assert.equal(await row(imported,second.id).getAttribute('data-reading-status'),'question');

    const portableContext=await browser.newContext({offline:true});
    const portable=await portableContext.newPage();watch(portable);await portable.goto(pathToFileURL(htmlPath).href+'#review');await portable.waitForSelector('[data-review-row]');
    assert.equal(await row(portable,second.id).getAttribute('data-reading-status'),'question');
    assert.equal(await portable.locator(`[data-review-note="${second.id}"]`).inputValue(),noteText);
    // Explicitly clearing a saved mark/note must win over the older embedded HTML backup.
    await status(portable,second.id,'unread');
    await portable.locator(`[data-review-note="${second.id}"]`).fill('');
    await portable.reload();await portable.waitForSelector('[data-review-row]');
    assert.equal(await row(portable,second.id).getAttribute('data-reading-status'),'unread');
    await portable.locator(`[data-review-note-toggle="${second.id}"]`).click();
    assert.equal(await portable.locator(`[data-review-note="${second.id}"]`).inputValue(),'');
    assert.equal(await portable.evaluate(()=>globalThis.reviewInjected),undefined);

    const blockedContext=await browser.newContext({offline:true});
    await blockedContext.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Denied','SecurityError');}}));
    const blocked=await blockedContext.newPage();watch(blocked);await blocked.goto(pathToFileURL(htmlPath).href+'#review');await blocked.waitForSelector('[data-review-row]');
    assert.equal(await row(blocked,second.id).getAttribute('data-reading-status'),'question');
    assert.equal(await blocked.locator(`[data-review-note="${second.id}"]`).inputValue(),noteText);
    await status(blocked,first.id,'question');
    assert.equal(await blocked.locator('[data-review-save-state]').getAttribute('data-level'),'warning');
    const fallbackPromise=blocked.waitForEvent('download');await backupAction(blocked,'export');
    const fallback=await fallbackPromise;await fallback.saveAs(path.join(output,'review-storage-blocked.json'));
    const fallbackData=JSON.parse(await fs.readFile(path.join(output,'review-storage-blocked.json'),'utf8'));
    assert.equal(fallbackData.entries[first.id].status,'question');

    const mobileContext=await browser.newContext({offline:true,isMobile:true,viewport:{width:390,height:844}});
    const mobile=await mobileContext.newPage();watch(mobile);await mobile.goto(url);await mobile.waitForSelector('.pr-review');
    await mobile.locator(`[data-review-file="${chosen.id}"]`).click();
    await status(mobile,first.id,'understood');
    await mobile.locator(`[data-review-note-toggle="${first.id}"]`).click();
    await mobile.locator(`[data-review-note="${first.id}"]`).fill('手机上也能标记和批注。');
    await mobile.locator('.rv-range-menu > summary').click();
    const rangeBox=await mobile.locator('[data-review-range-form]').boundingBox();
    assert.ok(rangeBox.x>=0&&rangeBox.x+rangeBox.width<=390,'Range controls must fit on mobile');
    await mobile.locator('[data-review-range-side]').selectOption(first.new!==null?'new':'old');
    await mobile.locator('[data-review-range-start]').fill(String(first.new??first.old));
    await mobile.locator('[data-review-range-end]').fill(String(first.new??first.old));
    await mobile.locator('[data-review-range-end]').press('Enter');
    assert.equal(await mobile.locator('[data-review-select]:checked').count(),1);
    await mobile.locator('.rv-range-menu > summary').click();
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await mobile.screenshot({path:path.join(output,'review-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
    const alignment=await checkAlignment({browser,file,review,output:path.join(output,'alignment')});
    const positions=await checkPositions({browser,file,review,output:path.join(output,'positions')});
    const report={ok:true,alignment,files:review.files.length,changeUnits:review.total_units,testedFile:chosen.path,snapshot:review.id,checks:['native text drag and Ctrl append select code ranges','line-number range selection with old/new sides and append','batch marking leaves unselected rows unchanged','all notes expanded with full text after reopening','direct note editing retains typing focus','full-width review workspace','collapsible directory tree and filename filter','syntax highlighting preserves every source line','separate right annotation panel','collapsible panels and optional code wrapping','all changed files listed','gray/green/yellow computed colors','Shift range and batch selection','individual yellow and side annotation','reload persistence','teaching edits preserve progress','browser process restart persistence','JSON export and import in a fresh context','wrong-snapshot and malformed imports rejected atomically','reset to gray persists','marked HTML restores in a fresh browser context','clearing entries overrides embedded backup','storage-denied recovery and export','untrusted annotations render as text','mobile range input and layout','zero external network requests']};
    report.positions=positions;
    await fs.writeFile(path.join(output,'review-check.json'),JSON.stringify(report,null,2)+'\n');return report;
  } finally {
    if(context)await context.close();if(browser)await browser.close();await fs.rm(profile,{recursive:true,force:true});
  }
}
module.exports={checkReview};
if(require.main===module){
  const args=process.argv.slice(2),outputIndex=args.indexOf('--out');
  if(!args[0]){process.stderr.write('Usage: node check_review.cjs guide.html [--out directory]\n');process.exitCode=1;}
  else{const load=createRequire(path.join(process.cwd(),'package.json'));const {chromium}=load(process.env.CODE_READING_PLAYWRIGHT||'playwright');checkReview({chromium,file:path.resolve(args[0]),output:path.resolve(outputIndex>=0?args[outputIndex+1]:args[0]+'.review-check')}).then(report=>process.stdout.write(JSON.stringify(report,null,2)+'\n')).catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});}
}
