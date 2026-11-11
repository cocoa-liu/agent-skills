'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

async function checkPositions({browser,file,review,output}) {
  const files=review.files.filter(file=>file.path.endsWith('.py')&&file.units>=100).slice(0,2);
  if(files.length<2)return {skipped:true,reason:'Position checks require two long source files'};
  await fs.mkdir(output,{recursive:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},offline:true});
  const errors=[];
  const rowId=files[0].hunks.flatMap(hunk=>hunk.rows).find(row=>row.id).id;
  const seed={schema:'code-reading-review/v1',snapshot_id:review.id,active_file:files[0].id,entries:{[rowId]:{status:'understood',note:'长批注会影响后续行的实际像素位置。\n'.repeat(12),updated_at:Date.now()}}};
  const position=page=>page.evaluate(()=>{
    const code=document.querySelector('.rv-diff-scroll'),top=code.getBoundingClientRect().top;
    const rows=[...code.querySelectorAll('.rv-row')],index=rows.findIndex(row=>row.getBoundingClientRect().bottom>top);
    return {index,offset:rows[index].getBoundingClientRect().top-top,top:code.scrollTop,left:code.scrollLeft};
  });
  const switchFile=async(page,file)=>{
    await page.locator(`[data-review-file="${file.id}"]`).click();
    // Restoration is deferred until code wrapping and expanded notes have their final sizes.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  const scrollTo=async(page,index,left)=>{
    await page.locator('.rv-diff-scroll').evaluate((code,{index,left})=>{
      code.scrollTop+=code.querySelectorAll('.rv-row')[index].getBoundingClientRect().top-code.getBoundingClientRect().top+7;
      code.scrollLeft=left;
    },{index,left});
    await page.waitForFunction(()=>Math.abs(document.querySelector('.rv-diff-scroll').scrollTop-document.querySelector('.rv-note-body').scrollTop)<=1);
    return position(page);
  };
  const expectPosition=async(page,expected,exactPixels=true)=>{
    const actual=await position(page);
    assert.equal(actual.index,expected.index,'Restore the same visible code row');
    assert.ok(Math.abs(actual.offset-expected.offset)<=1,'Preserve the offset within the code row');
    if(exactPixels){assert.ok(Math.abs(actual.top-expected.top)<=1);assert.ok(Math.abs(actual.left-expected.left)<=1);}
    assert.ok(await page.evaluate(()=>Math.abs(document.querySelector('.rv-diff-scroll').scrollTop-document.querySelector('.rv-note-body').scrollTop)<=1),'Annotations must follow the restored code position');
  };
  const action=async(page,name)=>{
    const menu=page.locator('.rv-backup-menu');if(!await menu.evaluate(element=>element.open))await menu.locator('summary').click();
    await page.locator(`[data-review-action="${name}"]`).click();
  };
  try {
    await context.addInitScript(({key,seed})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(seed));},{key:'code-reading-review:v1:'+review.id,seed});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(pathToFileURL(file).href+'#review');await switchFile(page,files[0]);
    const first=await scrollTo(page,45,80);
    await switchFile(page,files[1]);assert.equal((await position(page)).top,0,'An unread file starts at its beginning');
    const second=await scrollTo(page,60,120);
    await switchFile(page,files[0]);await expectPosition(page,first);
    await switchFile(page,files[0]);await expectPosition(page,first);
    await switchFile(page,files[1]);await expectPosition(page,second);
    await page.reload();await switchFile(page,files[1]);await expectPosition(page,second);
    await switchFile(page,files[0]);await expectPosition(page,first);

    // A saved row anchor remains meaningful after another file changes the wrapping mode.
    await switchFile(page,files[1]);await page.locator('[data-review-action=toggle-wrap]').click();
    await switchFile(page,files[0]);await expectPosition(page,first,false);
    await page.locator('[data-review-action=toggle-wrap]').click();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const exportedPosition=await position(page);
    const downloading=page.waitForEvent('download');await action(page,'export');
    const backupPath=path.join(output,'positions.json');await (await downloading).saveAs(backupPath);
    const backup=JSON.parse(await fs.readFile(backupPath,'utf8'));
    assert.equal(backup.file_positions[files[0].id].index,first.index);
    assert.equal(backup.file_positions[files[1].id].index,second.index);
    const saving=page.waitForEvent('download');await action(page,'save-html');
    const marked=path.join(output,'positions.html');await (await saving).saveAs(marked);
    const fresh=await browser.newContext({viewport:{width:1440,height:1000},offline:true});
    try {
      const restored=await fresh.newPage();restored.on('pageerror',error=>errors.push(error.message));
      await restored.goto(pathToFileURL(file).href+'#review');
      await restored.locator('[data-review-import-file]').setInputFiles(backupPath);
      await restored.waitForFunction(()=>document.querySelector('[data-review-save-state]').textContent.includes('已导入'));
      await switchFile(restored,files[0]);await expectPosition(restored,exportedPosition);
      const bad=path.join(output,'invalid-position.json');
      await fs.writeFile(bad,JSON.stringify({...backup,file_positions:{...backup.file_positions,[files[0].id]:{...backup.file_positions[files[0].id],index:999999}}}));
      await restored.locator('[data-review-import-file]').setInputFiles(bad);
      await restored.waitForFunction(()=>document.querySelector('[data-review-save-state]').textContent.includes('导入失败'));
      await expectPosition(restored,exportedPosition);
    } finally {await fresh.close();}
    const htmlContext=await browser.newContext({viewport:{width:1440,height:1000},offline:true});
    try {
      const restored=await htmlContext.newPage();restored.on('pageerror',error=>errors.push(error.message));
      await restored.goto(pathToFileURL(marked).href+'#review');
      await switchFile(restored,files[0]);await expectPosition(restored,exportedPosition);
      await restored.screenshot({path:path.join(output,'restored-position.png')});
    } finally {await htmlContext.close();}
    assert.deepEqual(errors,[]);
    const report={ok:true,files:files.map(file=>file.path),first,second,checks:['per-file vertical and horizontal positions','clicking the current file keeps position','new files start at the beginning','reload restores multiple file positions','row anchors survive wrapping changes','notes follow restored scrolling','JSON and saved HTML preserve positions','invalid position backup rejected','old backup without positions remains compatible']};
    await fs.writeFile(path.join(output,'position-check.json'),JSON.stringify(report,null,2)+'\n');return report;
  } finally {await context.close();}
}
module.exports={checkPositions};
