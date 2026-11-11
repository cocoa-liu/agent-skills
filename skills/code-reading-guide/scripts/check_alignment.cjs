'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

async function checkAlignment({browser,file,review,output}) {
  await fs.mkdir(output,{recursive:true});
  const chosen=review.files.find(file=>file.path.endsWith('.py')&&file.units>=40)||review.files.find(file=>file.units>=3)||review.files.find(file=>file.units>=2);
  if(!chosen)return {skipped:true};
  const rows=chosen.hunks.flatMap(hunk=>hunk.rows).filter(row=>row.id);
  const selected=[...new Set([rows[0],rows[1],rows[Math.floor(rows.length*0.65)]])];
  const ids=selected.map(row=>row.id);
  const notes=selected.map((row,index)=>index===0?'短批注，只占一行。':`第 ${index+1} 条批注\n同一行的代码与批注应处于同一水平位置。\n全部内容默认展开。`);
  const backup={schema:'code-reading-review/v1',snapshot_id:review.id,active_file:chosen.id,entries:Object.fromEntries(ids.map((id,index)=>[id,{status:index===1?'question':'understood',note:notes[index],updated_at:Date.now()}]))};
  const context=await browser.newContext({viewport:{width:1440,height:1000},offline:true});
  const errors=[];
  const metrics=page=>page.evaluate(ids=>{
    const code=document.querySelector('.rv-diff-scroll'),body=document.querySelector('.rv-note-body');
    const cards=ids.map(id=>document.querySelector(`[data-review-note-card="${id}"]`));
    if(cards.some(card=>!card))return null;
    const positions=ids.map((id,index)=>{
      const row=document.querySelector(`[data-review-row="${id}"]`).getBoundingClientRect();
      const card=cards[index].getBoundingClientRect(),editor=cards[index].querySelector('textarea'),style=getComputedStyle(editor);
      const noteY=editor.getBoundingClientRect().top+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop)+parseFloat(style.lineHeight)/2;
      return {codeY:row.top+11,noteY,cardTop:card.top,cardBottom:card.bottom};
    });
    return {aligned:document.querySelector('.rv-layout').classList.contains('rv-notes-aligned'),codeTop:code.scrollTop,noteTop:body.scrollTop,viewportDelta:code.getBoundingClientRect().top-body.getBoundingClientRect().top,positions};
  },ids);
  const waitAligned=async page=>{
    await page.waitForFunction(ids=>{
      const code=document.querySelector('.rv-diff-scroll'),body=document.querySelector('.rv-note-body');
      if(!document.querySelector('.rv-notes-aligned')||Math.abs(code.scrollTop-body.scrollTop)>1||Math.abs(code.getBoundingClientRect().top-body.getBoundingClientRect().top)>1)return false;
      return ids.every(id=>{
        const row=document.querySelector(`[data-review-row="${id}"]`),editor=document.querySelector(`[data-review-note="${id}"]`);
        if(!row||!editor)return false;
        const style=getComputedStyle(editor),noteY=editor.getBoundingClientRect().top+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop)+parseFloat(style.lineHeight)/2;
        const line=row.getBoundingClientRect(),note=editor.getBoundingClientRect();
        const contentHeight=Math.max(22,note.height,row.querySelector('.rv-code')?.getBoundingClientRect().height||0);
        return Math.abs(line.top+11-noteY)<1.5&&Math.abs(line.height-contentHeight)<1.5;
      });
    },ids);
    const result=await metrics(page);
    result.positions.slice(1).forEach((position,index)=>assert.ok(position.cardTop>=result.positions[index].cardBottom,'Adjacent expanded notes must not overlap'));
    return result;
  };
  try {
    await context.addInitScript(({key,backup})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(backup));},{key:'code-reading-review:v1:'+review.id,backup});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(pathToFileURL(file).href+'#review');
    const initial=await waitAligned(page);
    assert.equal(await page.locator('[data-review-note-card]').count(),ids.length);
    assert.equal(await page.locator('[data-review-note-card] header,[data-review-note-card] button,[data-review-note-card] select').count(),0,'Annotations should contain only editable content');
    const editor=page.locator(`[data-review-note="${ids[0]}"]`);
    const assertCompact=async()=>{
      assert.equal((await editor.boundingBox()).height,22,'Empty and short notes should occupy one line');
      assert.equal((await page.locator(`[data-review-note-card="${ids[0]}"]`).boundingBox()).height,22,'Note wrappers must not add vertical space');
      assert.ok((await page.locator(`[data-review-row="${ids[0]}"]`).boundingBox()).height<=26,'A short note must not create a tall code row');
    };
    await assertCompact();
    const initialSource=await page.locator('.rv-code code').allTextContents();
    const code=page.locator('.rv-diff-scroll'),noteBody=page.locator('.rv-note-body');
    // Exercise both wheel directions on actual scroll containers, including echo handling.
    const canScroll=await code.evaluate(element=>element.scrollHeight>element.clientHeight+200);
    if(canScroll){
      await code.hover({position:{x:180,y:110}});await page.mouse.wheel(0,180);
      await page.waitForFunction(()=>document.querySelector('.rv-diff-scroll').scrollTop>80);
      await waitAligned(page);
      const before=await noteBody.evaluate(element=>element.scrollTop);
      await noteBody.hover({position:{x:80,y:110}});await page.mouse.wheel(0,160);
      await page.waitForFunction(before=>document.querySelector('.rv-note-body').scrollTop>before+40,before);
      await waitAligned(page);
      await code.evaluate(element=>element.scrollTop=0);
      await page.waitForFunction(()=>document.querySelector('.rv-diff-scroll').scrollTop===0&&document.querySelector('.rv-note-body').scrollTop===0);
    }
    await page.locator(`[data-review-note="${ids[1]}"]`).hover();
    await page.waitForFunction(id=>document.querySelector(`[data-review-row="${id}"]`).classList.contains('rv-linked-line')&&document.querySelector(`[data-review-link="${id}"]`)?.classList.contains('rv-link-active'),ids[1]);
    await page.locator(`[data-review-note="${ids[1]}"]`).focus();await page.mouse.move(2,2);
    assert.ok(await page.locator(`[data-review-row="${ids[1]}"]`).evaluate(element=>element.classList.contains('rv-linked-line')));
    assert.match(await page.locator('[data-review-line-indicator]').innerText(),/当前对应/);
    await page.screenshot({path:path.join(output,'aligned-comments.png')});

    // Soft wrapping and explicit newlines both expand; deleting content shrinks again.
    await editor.fill('连续输入的长批注应自动换行。'.repeat(12));await waitAligned(page);
    assert.ok((await editor.boundingBox()).height>44);
    assert.ok(await editor.evaluate(element=>element.clientHeight>=element.scrollHeight-1));
    await editor.fill('');await waitAligned(page);await assertCompact();
    await editor.fill(notes[0]);await waitAligned(page);await assertCompact();
    assert.ok(await editor.evaluate(element=>element===document.activeElement),'Resizing must retain typing focus');
    const longNote=Array.from({length:32},(_,index)=>`第 ${index+1} 行：继续解释这段代码，并验证长批注不会覆盖相邻批注。`).join('\n');
    await editor.fill(longNote);await editor.pressSequentially('继续输入。');
    await waitAligned(page);
    assert.equal(await editor.inputValue(),longNote+'继续输入。');
    assert.ok(await editor.evaluate(element=>element.clientHeight>=element.scrollHeight-1));
    await page.locator(`[data-review-note-toggle="${ids[0]}"]`).click();
    await waitAligned(page);
    const line=await page.locator(`[data-review-row="${ids[0]}"] .rv-code`).boundingBox(),viewport=await code.boundingBox();
    assert.ok(line.y>=viewport.y-1&&line.y<viewport.y+viewport.height,'Locate must reveal the code line, not the bottom of a tall note');
    await page.locator('[data-review-action=toggle-wrap]').click();await waitAligned(page);
    await page.setViewportSize({width:1024,height:900});await waitAligned(page);
    await page.setViewportSize({width:390,height:844});
    await page.waitForFunction(()=>!document.querySelector('.rv-notes-aligned'));
    assert.equal(await page.locator('[data-review-note-card]').count(),ids.length);
    assert.equal(await page.locator('[data-review-row]').first().evaluate(element=>element.style.height),'');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await editor.fill(notes[0]);
    await page.waitForFunction(id=>document.querySelector(`[data-review-note="${id}"]`).getBoundingClientRect().height===22,ids[0]);
    await page.locator('.rv-notes').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,'compact-comments-mobile.png')});
    await page.setViewportSize({width:1440,height:1000});await waitAligned(page);
    await page.locator('[data-review-action=toggle-notes]').click();
    await page.waitForFunction(()=>!document.querySelector('.rv-notes-aligned'));
    assert.equal(await page.locator('[data-review-row]').first().evaluate(element=>element.style.height),'');
    await page.locator('[data-review-action=toggle-notes]').click();await waitAligned(page);
    assert.deepEqual(await page.locator('.rv-code code').allTextContents(),initialSource);
    await page.reload();await waitAligned(page);
    assert.equal(await page.locator(`[data-review-note="${ids[0]}"]`).inputValue(),notes[0]);
    await assertCompact();
    assert.deepEqual(errors,[]);
    const report={ok:true,testedFile:chosen.path,notes:ids.length,initial,checks:['first note text line aligns with code','content-only notes have no header or status controls','empty and short notes occupy one line','wrapped and multiline notes grow and shrink with content','adjacent expanded notes do not overlap','code and notes wheel scrolling follow each other','hover/focus arrows identify the matching line','long notes grow without losing text or typing focus','opening a tall note keeps its code line visible','wrapping and desktop resizing preserve alignment','mobile fallback and collapsed notes release code spacing','source text and old progress format unchanged','reload restores compact notes']};
    await fs.writeFile(path.join(output,'alignment-check.json'),JSON.stringify(report,null,2)+'\n');return report;
  } finally {await context.close();}
}
module.exports={checkAlignment};
