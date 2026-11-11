/* Offline PR reading marks, independent from the teaching content fingerprint. */
(() => {
  'use strict';
  const schema = 'code-reading-review/v1';
  const labels = {unread:'灰色 · 未读', understood:'绿色 · 已理解', question:'黄色 · 疑问 / 暂缓'};
  const sessions = new Map();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const jsonText = value => JSON.stringify(value).replace(/&/g,'\\u0026').replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  const allRows = file => file.hunks.flatMap(hunk => hunk.rows).filter(row => row.id);

  function validateBackup(value, session) {
    if (!value || value.schema !== schema || value.snapshot_id !== session.review.id) throw new Error('备份不属于当前 PR 代码快照，未导入任何标记。');
    if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw new Error('备份缺少有效的逐行进度。');
    const entries = Object.create(null);
    for (const [id, entry] of Object.entries(value.entries)) {
      if (!session.allowed.has(id) || !entry || typeof entry.status !== 'string' || !Object.hasOwn(labels,entry.status) || typeof entry.note !== 'string' || !Number.isFinite(entry.updated_at) || entry.updated_at < 0) throw new Error('备份包含无效代码行或批注，未导入任何标记。');
      entries[id] = {status:entry.status, note:entry.note, updated_at:entry.updated_at};
    }
    const positions=Object.create(null);
    if(value.file_positions!==undefined){
      if(!value.file_positions||typeof value.file_positions!=='object'||Array.isArray(value.file_positions))throw new Error('备份包含无效文件阅读位置，未导入任何标记。');
      for(const [id,position] of Object.entries(value.file_positions)){
        const file=session.review.files.find(file=>file.id===id),rows=file?.hunks.flatMap(hunk=>hunk.rows);
        if(!rows||!position||!Number.isInteger(position.index)||position.index< -1||position.index>=rows.length||!Number.isFinite(position.offset)||!Number.isFinite(position.top)||position.top<0||!Number.isFinite(position.left)||position.left<0||!Number.isFinite(position.updated_at)||position.updated_at<0||position.active_row!=null&&!rows.some(row=>row.id===position.active_row))throw new Error('备份包含无效文件阅读位置，未导入任何标记。');
        positions[id]={index:position.index,offset:position.offset,top:position.top,left:position.left,active_row:position.active_row||null,updated_at:position.updated_at};
      }
    }
    return {entries,positions,active_file:session.review.files.some(file=>file.id===value.active_file)?value.active_file:null,active_row:session.allowed.has(value.active_row)?value.active_row:null};
  }
  function mergeEntries(session, incoming) {
    for(const [id, entry] of Object.entries(incoming)) if(!session.entries[id] || entry.updated_at >= session.entries[id].updated_at) session.entries[id] = entry;
  }
  function mergePositions(session,incoming) {
    for(const [id,position] of Object.entries(incoming))if(!session.filePositions[id]||position.updated_at>=session.filePositions[id].updated_at)session.filePositions[id]=position;
  }
  function snapshot(session) {
    rememberPosition(session);
    return {schema,snapshot_id:session.review.id,base:session.review.base,head:session.review.head,mode:session.review.mode,active_file:session.activeFile,active_row:session.activeRow,file_positions:session.filePositions,entries:session.entries,exported_at:new Date().toISOString()};
  }
  function createSession(review) {
    const session = {review,key:'code-reading-review:v1:'+review.id,allowed:new Set(review.files.flatMap(allRows).map(row=>row.id)),entries:Object.create(null),filePositions:Object.create(null),activeFile:review.files[0]?.id,activeRow:null,draftRow:null,hoverRow:null,selected:new Set(),collapsedFolders:new Set(),treeHidden:false,notesHidden:false,wrap:false,lastSelected:null,filter:'',message:'尚无标记。修改颜色或批注后会自动保存到本浏览器。',level:'normal',root:null};
    const seed = document.getElementById('pr-review-saved-progress');
    try {
      if(seed) {const stored=validateBackup(JSON.parse(seed.textContent),session);mergeEntries(session,stored.entries);mergePositions(session,stored.positions);session.activeFile=stored.active_file||session.activeFile;session.activeRow=stored.active_row||session.activeRow;session.message='已从 HTML 恢复随文件保存的标记和批注。';}
    } catch(error) {session.message=error.message;session.level='warning';}
    try {
      const raw = localStorage.getItem(session.key);
      if(raw) {const stored=validateBackup(JSON.parse(raw),session);mergeEntries(session,stored.entries);mergePositions(session,stored.positions);session.activeFile=stored.active_file||session.activeFile;session.activeRow=stored.active_row||session.activeRow;session.message='已恢复本浏览器保存的阅读标记和批注。';session.level='normal';}
    } catch {session.message='浏览器存储不可用或记录无法读取；当前标记仍可导出，或保存到带标记的 HTML。';session.level='warning';}
    return session;
  }
  function showSaveState(session) {
    const node=session.root?.querySelector('[data-review-save-state]');
    if(node){node.textContent=session.message;node.dataset.level=session.level;}
  }
  function persist(session) {
    clearTimeout(session.positionTimer);session.positionTimer=null;
    try {
      const previous=localStorage.getItem(session.key);
      if(previous){const stored=validateBackup(JSON.parse(previous),session);mergeEntries(session,stored.entries);mergePositions(session,stored.positions);}
      localStorage.setItem(session.key,JSON.stringify(snapshot(session)));
      session.message='已自动保存到本浏览器 · '+new Date().toLocaleTimeString();session.level='normal';
    } catch {session.message='未能写入浏览器存储；本次标记仍在页面中，请导出备份或保存带标记的 HTML。';session.level='warning';}
    showSaveState(session);
  }
  function setEntry(session, id, changes) {
    let previous=session.entries[id] || {status:'unread',note:'',updated_at:0};
    // Read the latest row before editing so two open tabs do not discard each other's notes.
    try {const raw=localStorage.getItem(session.key);if(raw){const live=validateBackup(JSON.parse(raw),session).entries[id];if(live && live.updated_at>previous.updated_at)previous=live;}} catch {}
    session.entries[id] = {...previous,...changes,updated_at:Math.max(Date.now(),previous.updated_at+1)};
  }
  function counts(session, file) {
    const rows=file?allRows(file):session.review.files.flatMap(allRows);
    const result={unread:0,understood:0,question:0,total:rows.length};
    for(const row of rows) result[session.entries[row.id]?.status||'unread']++;
    return result;
  }
  const icon = name => {
    const paths = {
      folder:'M1.75 3.5h4l1.5 1.75h7v8.5h-12.5z',
      file:'M4 1.75h5.5L13 5.25v9H4z M9.5 1.75v3.5H13',
      comment:'M2 2.75h12v8.5H7l-3.5 2.5v-2.5H2z',
      tree:'M3 1.5v10h3 M3 5h3 M8 3h6v4H8z M8 10h6v4H8z'
    };
    return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="${paths[name]||paths.file}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  };
  const locationLabel = row => row.kind==='delete'?'旧 L'+row.old:row.kind==='add'?'新 L'+row.new:'文件变更';
  const currentFile = session => session.review.files.find(file=>file.id===session.activeFile);
  function activeRow(session) {
    const rows=currentFile(session)?allRows(currentFile(session)):[];
    const row=rows.find(item=>item.id===session.activeRow)||rows.find(item=>session.entries[item.id]?.note)||rows[0];
    session.activeRow=row?.id;
    return row;
  }
  function fileList(session) {
    const tree={directories:new Map(),files:[]};
    const visible=session.review.files.filter(file=>`${file.path} ${file.old_path||''}`.toLowerCase().includes(session.filter.toLowerCase()));
    for(const file of visible){
      const parts=file.path.split('/');let branch=tree,path='';
      for(const part of parts.slice(0,-1)){
        path+=(path?'/':'')+part;
        if(!branch.directories.has(part))branch.directories.set(part,{path,directories:new Map(),files:[]});
        branch=branch.directories.get(part);
      }
      branch.files.push(file);
    }
    const draw=branch=>`<ul class="rv-tree-list">${[...branch.directories].sort(([a],[b])=>a.localeCompare(b)).map(([name,child])=>`<li><details data-review-folder="${escape(child.path)}" ${!session.collapsedFolders.has(child.path)||session.filter?'open':''}><summary>${icon('folder')}<span>${escape(name)}</span></summary>${draw(child)}</details></li>`).join('')}${branch.files.sort((a,b)=>a.path.localeCompare(b.path)).map(file=>{
      const count=counts(session,file),name=file.path.split('/').at(-1);
      return `<li><button class="rv-file-button" data-review-file="${file.id}" aria-current="${session.activeFile===file.id}" title="${escape(file.path)} · 已理解 ${count.understood}/${count.total} · 疑问 ${count.question}">${icon('file')}<span class="rv-file-name">${escape(name)}</span><span class="rv-file-status">${escape(file.status[0])}</span><span class="rv-file-summary">${count.understood}/${count.total}${count.question?' · ?'+count.question:''}</span><span class="rv-file-bar"><span class="green" style="width:${count.total?100*count.understood/count.total:0}%"></span><span class="yellow" style="width:${count.total?100*count.question/count.total:0}%"></span></span></button></li>`;
    }).join('')}</ul>`;
    return visible.length?draw(tree):'<p class="rv-empty">没有匹配的文件。</p>';
  }
  function refreshProgress(session) {
    const list=session.root.querySelector('[data-review-file-list]'),scroll=list.scrollTop;
    list.innerHTML=fileList(session);list.scrollTop=scroll;
    const count=counts(session);
    session.root.querySelector('[data-review-overall]').textContent=`${session.review.files.length} 个文件 · 已理解 ${count.understood}/${count.total} · 疑问 ${count.question} · 未读 ${count.unread}`;
    refreshSelection(session);
  }
  function refreshSelection(session) {
    session.root.querySelectorAll('[data-review-mark]').forEach(button=>button.disabled=session.selected.size===0);
    const label=session.root.querySelector('[data-review-selection-count]');
    if(label)label.textContent=`已选 ${session.selected.size} 行`;
  }
  function paintSelection(session) {
    // Keep the source DOM intact so native text selection and copying still work.
    session.root.querySelectorAll('[data-review-row]').forEach(row=>{
      const selected=session.selected.has(row.dataset.reviewRow);
      row.classList.toggle('rv-selected',selected);row.querySelector('[data-review-select]').checked=selected;
    });
    refreshSelection(session);
  }
  function selectTextRows(session,append=false) {
    const selection=window.getSelection(),scroll=session.root.querySelector('.rv-diff-scroll');
    if(!selection||selection.isCollapsed||!selection.rangeCount||!scroll?.contains(selection.anchorNode)||!scroll.contains(selection.focusNode))return false;
    const range=selection.getRangeAt(0);
    const rows=[...scroll.querySelectorAll('[data-review-row]')].filter(row=>range.intersectsNode(row.querySelector('.rv-code')));
    if(!rows.length)return false;
    if(!append)session.selected.clear();
    rows.forEach(row=>session.selected.add(row.dataset.reviewRow));
    session.lastSelected=allRows(currentFile(session)).findIndex(row=>row.id===rows.at(-1).dataset.reviewRow);
    paintSelection(session);return true;
  }
  function selectLineRange(session,form) {
    const side=form.querySelector('[data-review-range-side]').value;
    const start=Number(form.querySelector('[data-review-range-start]').value),end=Number(form.querySelector('[data-review-range-end]').value);
    const message=form.querySelector('[data-review-range-message]');
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<1){message.textContent='请输入大于 0 的起止行号。';return;}
    const rows=allRows(currentFile(session)).filter(row=>row[side]!=null&&row[side]>=Math.min(start,end)&&row[side]<=Math.max(start,end));
    if(!rows.length){message.textContent='这个范围没有该侧的改动行，已保留当前选择。';return;}
    if(!form.querySelector('[data-review-range-append]').checked)session.selected.clear();
    rows.forEach(row=>session.selected.add(row.id));
    session.lastSelected=allRows(currentFile(session)).findIndex(row=>row.id===rows.at(-1).id);
    window.getSelection()?.removeAllRanges();paintSelection(session);
    message.textContent=`已选 ${side==='new'?'新':'旧'} L${Math.min(start,end)}–L${Math.max(start,end)} 中的 ${rows.length} 处改动。`;
  }
  // Highlight both sides of a hunk separately; balance multiline token spans per row.
  const syntaxCache=new WeakMap();
  function syntaxRows(file) {
    if(syntaxCache.has(file))return syntaxCache.get(file);
    const output=new Map(),extension=file.path.split('.').at(-1).toLowerCase();
    const aliases={py:'python',pyi:'python',js:'javascript',jsx:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',tsx:'typescript',yml:'yaml',h:'c',hpp:'cpp',cc:'cpp',sh:'bash',rs:'rust',md:'markdown',rst:'plaintext',toml:'ini'};
    const language=aliases[extension]||extension;
    if(window.hljs?.getLanguage(language)){
      for(const hunk of file.hunks)for(const side of ['old','new']){
        const rows=hunk.rows.filter(row=>side==='old'?row.kind==='delete'||row.kind==='context':row.kind==='add'||row.kind==='context');
        if(!rows.length)continue;
        const html=hljs.highlight(rows.map(row=>row.text).join('\n'),{language,ignoreIllegals:true}).value;
        const fragment=document.createElement('div');fragment.innerHTML=html;
        const lines=[''],tags=[];
        const walk=node=>{
          if(node.nodeType===Node.TEXT_NODE){
            const pieces=node.textContent.split('\n');
            pieces.forEach((piece,index)=>{
              if(index){lines[lines.length-1]+='</span>'.repeat(tags.length);lines.push(tags.join(''));}
              lines[lines.length-1]+=escape(piece);
            });
          }else if(node.nodeType===Node.ELEMENT_NODE){
            const tag=`<span class="${escape(node.className)}">`;
            lines[lines.length-1]+=tag;tags.push(tag);node.childNodes.forEach(walk);tags.pop();lines[lines.length-1]+='</span>';
          }
        };
        fragment.childNodes.forEach(walk);
        rows.forEach((row,index)=>output.set(row,lines[index]??escape(row.text)));
      }
    }
    syntaxCache.set(file,output);return output;
  }
  function rowView(session,row,syntax) {
    const entry=session.entries[row.id]||{status:'unread',note:''};
    const label=escape(locationLabel(row)),marked=Boolean(row.id);
    return `<tr class="rv-row ${marked?entry.status:'context'} ${entry.note?'rv-annotated':''} ${session.selected.has(row.id)?'rv-selected':''} ${session.activeRow===row.id?'rv-active-line':''}" ${marked?`data-review-row="${row.id}" data-reading-status="${entry.status}"`:''}><td class="rv-check-cell">${marked?`<input type="checkbox" data-review-select="${row.id}" aria-label="选择 ${label}" ${session.selected.has(row.id)?'checked':''}>`:''}</td><td class="rv-line-number">${row.old??''}</td><td class="rv-line-number">${row.new??''}</td><td class="rv-sign ${row.kind}">${row.kind==='add'?'+':row.kind==='delete'?'−':''}</td><td class="rv-source-cell"><pre class="rv-code"><code>${syntax.get(row)??escape(row.text)}</code>${row.ending&&row.ending!=='LF'?`<span class="rv-ending">${row.ending==='none'?'[无末尾换行]':'[CRLF]'}</span>`:''}</pre></td><td class="rv-comment-cell">${marked?`<button data-review-note-toggle="${row.id}" class="rv-line-comment ${entry.note?'has-note':''}" aria-label="${label} ${entry.note?'编辑':'添加'}批注" title="${entry.note?'已有批注，点击编辑':'在右侧批注'}">${icon('comment')}</button>`:''}</td></tr>`;
  }
  function fileView(session) {
    const file=currentFile(session);
    if(!file)return '<div class="rv-empty">当前比较范围没有改动文件。</div>';
    activeRow(session);
    const syntax=syntaxRows(file),names={A:'新增',M:'修改',D:'删除',R:'重命名',C:'复制',T:'类型变化'};
    const moved=file.old_path&&file.new_path&&file.old_path!==file.new_path;
    return `<header class="rv-file-heading"><div>${icon('file')}<h2>${escape(file.path)}</h2></div><span class="rv-file-meta">${names[file.status[0]]||escape(file.status)} <b class="rv-added">+${file.added}</b> <b class="rv-deleted">−${file.deleted}</b>${moved?' · 原路径 '+escape(file.old_path):''}</span></header><div class="rv-bulk"><button data-review-action="select-file">选中整文件</button><button data-review-action="clear-selection">取消选择</button><details class="rv-range-menu"><summary>行号范围</summary><form data-review-range-form><label>按<select data-review-range-side aria-label="行号版本"><option value="new">新行号</option><option value="old">旧行号</option></select></label><div class="rv-range-inputs"><label>起始<input type="number" min="1" step="1" required data-review-range-start aria-label="起始行号"></label><span>—</span><label>结束<input type="number" min="1" step="1" required data-review-range-end aria-label="结束行号"></label></div><label class="rv-range-append"><input type="checkbox" data-review-range-append>追加到已选代码</label><button type="submit">选择范围</button><p data-review-range-message role="status">只选择该侧的改动行，上下文不计入进度。</p></form></details><button data-review-mark="understood" data-status="understood" disabled>标绿 · 已理解</button><button data-review-mark="question" data-status="question" disabled>标黄 · 疑问</button><button data-review-mark="unread" data-status="unread" disabled>恢复灰色</button><span class="rv-selection-count" data-review-selection-count></span></div><div class="rv-selection-help">拖选代码文字即可批量选择，再点标绿 / 标黄。Ctrl / ⌘ 拖选可追加；也可用“行号范围”或 Shift 连选。</div><div class="rv-diff-scroll ${session.wrap?'rv-wrap':''}" tabindex="0" aria-label="差异代码，支持横向滚动"><table class="rv-diff-table" aria-label="${escape(file.path)} 代码差异"><thead><tr><th></th><th>旧行</th><th>新行</th><th></th><th>代码 · 点击改动行查看右侧批注</th><th></th></tr></thead>${file.hunks.map((hunk,index)=>`<tbody><tr class="rv-hunk-heading"><td colspan="6"><div><span>${escape(hunk.header)}</span><button data-review-hunk="${index}">选中此段</button></div></td></tr>${hunk.rows.map(row=>rowView(session,row,syntax)).join('')}</tbody>`).join('')}</table></div>`;
  }
  function notesView(session) {
    const file=currentFile(session),row=activeRow(session);
    if(!row)return '<h2>批注</h2><p class="rv-empty">选择一处代码改动开始阅读。</p>';
    const count=allRows(file).filter(item=>session.entries[item.id]?.note).length;
    return `<header class="rv-notes-heading"><div class="rv-notes-title"><h2>${icon('comment')} 全部批注 <span data-review-note-count>${count}</span></h2><span>自动保存</span></div><p class="rv-note-tip">按行对齐 · 滚动跟随 · 全文展开</p><div class="rv-line-indicator" data-review-line-indicator></div></header><div class="rv-note-body"><div class="rv-note-list" data-review-note-list>${noteList(session)}</div></div>`;
  }
  function noteList(session) {
    const file=currentFile(session);
    const rows=file?allRows(file).filter(row=>session.entries[row.id]?.note||row.id===session.draftRow):[];
    return rows.map(row=>{
      const entry=session.entries[row.id]||{status:'unread',note:''};
      const label=escape(locationLabel(row));
      return `<article class="rv-note-card ${row.id===session.activeRow?'rv-note-active':''}" data-review-note-card="${row.id}"><textarea rows="1" data-review-note="${row.id}" aria-label="${label} 文字批注" title="${label}" placeholder="写批注…">${escape(entry.note)}</textarea></article>`;
    }).join('')||'<p class="rv-note-empty">点击代码行或批注气泡，添加你的理解与疑问。</p>';
  }
  function resizeNote(textarea) {
    if(!textarea.clientWidth)return;
    textarea.style.height='auto';textarea.style.height=textarea.scrollHeight+'px';
  }
  function resizeNotes(session) {
    session.root.querySelectorAll('[data-review-note]').forEach(resizeNote);
    queueAlignment(session);
  }
  function repaintNotes(session) {
    const top=session.root.querySelector('.rv-note-body')?.scrollTop||0;
    session.root.querySelector('[data-review-notes]').innerHTML=notesView(session);
    resizeNotes(session);
    const body=session.root.querySelector('.rv-note-body');if(body)body.scrollTop=top;
  }
  function captureCodeAnchor(session) {
    const scroll=session.root.querySelector('.rv-diff-scroll');
    if(!scroll)return null;
    const top=scroll.getBoundingClientRect().top,rows=[...scroll.querySelectorAll('.rv-row')];
    const index=rows.findIndex(row=>row.getBoundingClientRect().bottom>top);
    return {index,offset:index>=0?rows[index].getBoundingClientRect().top-top:0,top:scroll.scrollTop,left:scroll.scrollLeft};
  }
  function rememberPosition(session) {
    // Do not mistake a newly rendered file's temporary layout for its saved position.
    if(!session.root?.isConnected||session.layoutAnchor||session.aligning)return false;
    const anchor=captureCodeAnchor(session);if(!anchor)return false;
    const position={...anchor,active_row:session.activeRow||null},previous=session.filePositions[session.activeFile];
    if(previous&&Object.entries(position).every(([key,value])=>previous[key]===value))return false;
    session.filePositions[session.activeFile]={...position,updated_at:Math.max(Date.now(),(previous?.updated_at||0)+1)};
    return true;
  }
  function restoredPosition(session) {
    return session.filePositions[session.activeFile]||{index:-1,offset:0,top:0,left:0};
  }
  function writeScrollTop(session,element,value) {
    if(Math.abs(element.scrollTop-value)<0.5)return;
    element.scrollTop=value;
    (session.scrollWrites ||= new WeakMap()).set(element,element.scrollTop);
  }
  function queueAlignment(session) {
    if(session.alignmentFrame)return;
    session.alignmentFrame=requestAnimationFrame(()=>{session.alignmentFrame=null;if(session.root.isConnected)alignAnnotations(session);});
  }
  function alignAnnotations(session) {
    const root=session.root,layout=root.querySelector('.rv-layout'),scroll=root.querySelector('.rv-diff-scroll');
    const notes=root.querySelector('.rv-note-body'),list=root.querySelector('[data-review-note-list]'),heading=root.querySelector('.rv-notes-heading');
    if(!scroll||!notes||!list)return;
    const anchor=session.layoutAnchor||captureCodeAnchor(session);session.layoutAnchor=null;
    session.aligning=true;
    const aligned=!session.notesHidden&&matchMedia('(min-width: 801px)').matches;
    layout.classList.toggle('rv-notes-aligned',aligned);
    const rows=[...scroll.querySelectorAll('.rv-row')],cards=[...list.querySelectorAll('[data-review-note-card]')];
    const byId=new Map(rows.filter(row=>row.dataset.reviewRow).map(row=>[row.dataset.reviewRow,row]));
    rows.forEach(row=>row.style.removeProperty('height'));
    cards.forEach(card=>card.style.removeProperty('top'));
    heading.style.removeProperty('height');notes.style.removeProperty('height');list.style.removeProperty('height');
    root.querySelectorAll('[data-review-note]').forEach(resizeNote);
    if(aligned){
      // Reserve only the content height; short comments occupy one code line.
      for(const card of cards){const row=byId.get(card.dataset.reviewNoteCard);if(row)row.style.height=Math.ceil(card.getBoundingClientRect().height)+'px';}
      const codeTop=scroll.getBoundingClientRect().top,notesPanel=root.querySelector('[data-review-notes]');
      heading.style.height=Math.max(0,codeTop-notesPanel.getBoundingClientRect().top-notesPanel.clientTop)+'px';
      notes.style.height=scroll.clientHeight+'px';
      list.style.height=scroll.scrollHeight+'px';
      for(const card of cards){
        const row=byId.get(card.dataset.reviewNoteCard);if(!row)continue;
        // The borderless editor and code both use a 22px line height.
        card.style.top=Math.max(0,row.getBoundingClientRect().top-codeTop+scroll.scrollTop)+'px';
      }
    }
    if(anchor){
      const row=rows[anchor.index],line=row?.getBoundingClientRect();
      // Keep the same row visible even if wrapping or note height changed in another file.
      const offset=line?Math.max(anchor.offset,1-line.height):0;
      writeScrollTop(session,scroll,line?line.top-scroll.getBoundingClientRect().top+scroll.scrollTop-offset:anchor.top);
      if(anchor.left!==undefined)scroll.scrollLeft=anchor.left;
    }
    if(aligned)writeScrollTop(session,notes,scroll.scrollTop);
    session.aligning=false;
    updateLineIndicators(session);
  }
  function syncReviewScroll(session,source) {
    const code=session.root.querySelector('.rv-diff-scroll'),notes=session.root.querySelector('.rv-note-body');
    const target=source===code?notes:source===notes?code:null;
    if(!target)return;
    // Ignore echoes from our last write, not new wheel/keyboard input on either pane.
    const expected=session.scrollWrites?.get(source);session.scrollWrites?.delete(source);
    if(expected!==undefined&&Math.abs(source.scrollTop-expected)<=1){drawLineLinks(session);return;}
    if(session.aligning||session.alignmentFrame||!session.root.querySelector('.rv-notes-aligned'))return;
    if(Math.abs(target.scrollTop-source.scrollTop)>1)writeScrollTop(session,target,source.scrollTop);
    drawLineLinks(session);
  }
  function drawLineLinks(session) {
    const root=session.root,svg=root.querySelector('[data-review-links]'),layout=root.querySelector('.rv-layout');
    if(!svg)return;
    if(!layout.classList.contains('rv-notes-aligned')){svg.innerHTML='';return;}
    const origin=layout.getBoundingClientRect(),viewport=root.querySelector('.rv-diff-scroll').getBoundingClientRect();
    const current=session.hoverRow||session.activeRow,paths=[];
    svg.setAttribute('viewBox',`0 0 ${origin.width} ${origin.height}`);
    for(const card of root.querySelectorAll('[data-review-note-card]')){
      const id=card.dataset.reviewNoteCard,row=root.querySelector(`[data-review-row="${id}"]`);
      if(!row)continue;
      const line=row.getBoundingClientRect(),y=line.top+11;
      if(y<viewport.top||y>viewport.bottom)continue;
      const x1=viewport.right-origin.left,x2=card.getBoundingClientRect().left-origin.left-2,relativeY=y-origin.top;
      paths.push(`<path data-review-link="${id}" class="${id===current?'rv-link-active':''}" d="M ${x1} ${relativeY} H ${x2} M ${x2-4} ${relativeY-3} L ${x2} ${relativeY} L ${x2-4} ${relativeY+3}"/>`);
    }
    svg.innerHTML=paths.join('');
  }
  function updateLineIndicators(session) {
    const root=session.root,id=session.hoverRow||session.activeRow;
    root.querySelectorAll('[data-review-row]').forEach(row=>{
      row.classList.toggle('rv-active-line',row.dataset.reviewRow===session.activeRow);
      row.classList.toggle('rv-linked-line',row.dataset.reviewRow===id);
    });
    root.querySelectorAll('[data-review-note-card]').forEach(card=>card.classList.toggle('rv-note-active',card.dataset.reviewNoteCard===id));
    const row=currentFile(session)&&allRows(currentFile(session)).find(row=>row.id===id),label=root.querySelector('[data-review-line-indicator]');
    if(label)label.textContent=row?'当前对应：'+locationLabel(row):'点击代码行添加批注';
    drawLineLinks(session);
  }
  function setLayout(session) {
    const layout=session.root.querySelector('.rv-layout');
    layout.classList.toggle('rv-tree-hidden',session.treeHidden);layout.classList.toggle('rv-notes-hidden',session.notesHidden);
    for(const [action,open] of [['toggle-tree',!session.treeHidden],['toggle-notes',!session.notesHidden]])session.root.querySelector(`[data-review-action="${action}"]`).setAttribute('aria-pressed',String(open));
    resizeNotes(session);
  }
  function render(session) {
    session.root.innerHTML=`<section class="pr-review"><header class="rv-toolbar"><div><h1>PR 阅读进度 <span class="rv-total-badge">${session.review.files.length} files</span></h1><p class="rv-subtitle">按文件阅读改动，记录理解与疑问。</p></div><div class="rv-top-actions"><button data-review-action="toggle-tree" aria-pressed="true">${icon('tree')} 文件树</button><button data-review-action="toggle-notes" aria-pressed="true">${icon('comment')} 批注栏</button><button data-review-action="toggle-wrap" aria-pressed="${session.wrap}">自动换行</button><details class="rv-backup-menu"><summary>保存与备份 ▾</summary><div><button data-review-action="export">导出进度 JSON</button><button data-review-action="import">导入进度 JSON</button><button data-review-action="save-html">保存带标记的 HTML</button><p>同一浏览器自动恢复；换浏览器或移动文件时使用备份。</p></div></details><input class="rv-hidden" type="file" accept=".json,application/json" data-review-import-file></div></header><div class="rv-statusbar"><div class="rv-legend"><span><i class="rv-dot unread"></i>未读</span><span><i class="rv-dot understood"></i>已理解</span><span><i class="rv-dot question"></i>疑问 / 暂缓</span></div><strong data-review-overall></strong><span class="rv-save-state" data-review-save-state role="status"></span></div><div class="rv-layout"><aside class="rv-files" aria-label="改动文件树"><header><strong>Files changed</strong><span>${session.review.files.length}</span></header><label class="rv-search-label"><span class="rv-sr-only">筛选改动文件</span><input type="search" value="${escape(session.filter)}" data-review-filter placeholder="筛选文件…"></label><nav class="rv-file-list" data-review-file-list aria-label="按目录浏览文件"></nav></aside><section class="rv-main" data-review-file-content>${fileView(session)}</section><aside class="rv-notes" data-review-notes aria-label="独立批注栏">${notesView(session)}</aside><svg class="rv-line-links" data-review-links aria-hidden="true"></svg></div><footer class="rv-footnote">${escape(session.review.base.slice(0,12))} → ${escape(session.review.head.slice(0,12))}${session.review.mode==='tracked-working-tree'?' · 已跟踪工作区改动（不含未跟踪文件）':''} · 阅读标记绑定代码版本，讲解更新不影响进度。</footer></section>`;
    session.layoutAnchor=restoredPosition(session);
    setLayout(session);showSaveState(session);refreshProgress(session);
  }
  function download(filename, content, type) {
    const url=URL.createObjectURL(new Blob([content],{type}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function saveHtml(session) {
    const clone=document.documentElement.cloneNode(true);
    clone.querySelector('#pr-review-saved-progress')?.remove();
    const seed=document.createElement('script');seed.id='pr-review-saved-progress';seed.type='application/json';seed.textContent=jsonText(snapshot(session));clone.querySelector('head').append(seed);
    clone.querySelectorAll('dialog[open]').forEach(dialog=>dialog.removeAttribute('open'));
    download('code-reading-marked-'+session.review.head.slice(0,12)+'.html','<!doctype html>\n'+clone.outerHTML,'text/html;charset=utf-8');
    session.message='已生成带标记和批注的 HTML；打开下载的文件也能恢复进度。';session.level='normal';showSaveState(session);
  }
  function repaintRows(session,restore=null) {
    session.layoutAnchor=restore||captureCodeAnchor(session);
    const position=session.layoutAnchor||{top:0,left:0};
    session.root.querySelector('[data-review-file-content]').innerHTML=fileView(session);
    const next=session.root.querySelector('.rv-diff-scroll');
    if(next){next.scrollTop=position.top;next.scrollLeft=position.left;}
    repaintNotes(session);refreshProgress(session);
  }
  function showNote(session,id,focus=false) {
    session.layoutAnchor=captureCodeAnchor(session);
    session.activeRow=id;session.draftRow=id;session.hoverRow=null;session.notesHidden=false;setLayout(session);
    session.root.querySelectorAll('[data-review-row]').forEach(row=>row.classList.toggle('rv-active-line',row.dataset.reviewRow===id));
    repaintNotes(session);persist(session);
    alignAnnotations(session);
    if(matchMedia('(min-width: 801px)').matches)locateRow(session,id);
    else session.root.querySelector(`[data-review-note-card="${id}"]`)?.scrollIntoView({block:'nearest'});
    if(focus)session.root.querySelector(`[data-review-note="${id}"]`)?.focus({preventScroll:true});
    if(matchMedia('(max-width: 800px)').matches)session.root.querySelector('[data-review-notes]').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function locateRow(session,id) {
    const row=session.root.querySelector(`[data-review-row="${id}"]`),scroll=session.root.querySelector('.rv-diff-scroll');
    if(!row||!scroll)return;
    const line=row.getBoundingClientRect(),viewport=scroll.getBoundingClientRect();
    if(line.top<viewport.top||line.top+22>viewport.bottom)scroll.scrollTop+=line.top-viewport.top;
    syncReviewScroll(session,scroll);
    if(matchMedia('(max-width: 800px)').matches)scroll.scrollIntoView({block:'center',inline:'nearest'});
  }
  function mount(root, review) {
    if(!review?.enabled){root.innerHTML='<p class="rv-empty">生成 PR 导读时提供 base 与 head，才能展示全部改动。</p>';return;}
    let session=sessions.get(review.id);
    if(!session){session=createSession(review);sessions.set(review.id,session);}
    session.root=root;render(session);
    root.addEventListener('toggle',event=>{
      const folder=event.target.dataset.reviewFolder;
      if(folder&&!session.filter){event.target.open?session.collapsedFolders.delete(folder):session.collapsedFolders.add(folder);}
    },true);
    root.onclick=event=>{
      const target=event.target.closest('button,input[type=checkbox]');
      if(!target){const row=event.target.closest('[data-review-row]');if(row&&!selectTextRows(session,event.ctrlKey||event.metaKey))showNote(session,row.dataset.reviewRow);return;}
      const data=target.dataset,file=currentFile(session);
      if(data.reviewFile){
        if(data.reviewFile===session.activeFile)return;
        rememberPosition(session);session.activeFile=data.reviewFile;
        const position=restoredPosition(session);
        session.activeRow=position.active_row||null;session.draftRow=null;session.hoverRow=null;session.selected.clear();session.lastSelected=null;
        repaintRows(session,position);persist(session);return;
      }
      if(data.reviewSelect){const ids=allRows(file).map(row=>row.id),index=ids.indexOf(data.reviewSelect);if(event.shiftKey&&session.lastSelected!==null){for(let at=Math.min(index,session.lastSelected);at<=Math.max(index,session.lastSelected);at++)target.checked?session.selected.add(ids[at]):session.selected.delete(ids[at]);}else{target.checked?session.selected.add(data.reviewSelect):session.selected.delete(data.reviewSelect);}session.lastSelected=index;window.getSelection()?.removeAllRanges();paintSelection(session);return;}
      if(data.reviewHunk!==undefined){for(const row of file.hunks[Number(data.reviewHunk)].rows)if(row.id)session.selected.add(row.id);window.getSelection()?.removeAllRanges();paintSelection(session);return;}
      if(data.reviewMark){for(const id of session.selected)setEntry(session,id,{status:data.reviewMark});session.selected.clear();persist(session);repaintRows(session);return;}
      if(data.reviewNoteToggle){showNote(session,data.reviewNoteToggle,true);return;}
      if(data.reviewAction==='select-file'){session.selected=new Set(allRows(file).map(row=>row.id));window.getSelection()?.removeAllRanges();paintSelection(session);return;}
      if(data.reviewAction==='clear-selection'){session.selected.clear();session.lastSelected=null;window.getSelection()?.removeAllRanges();paintSelection(session);return;}
      if(data.reviewAction==='toggle-tree'){session.treeHidden=!session.treeHidden;setLayout(session);return;}
      if(data.reviewAction==='toggle-notes'){session.notesHidden=!session.notesHidden;setLayout(session);return;}
      if(data.reviewAction==='toggle-wrap'){session.wrap=!session.wrap;target.setAttribute('aria-pressed',String(session.wrap));session.layoutAnchor=captureCodeAnchor(session);root.querySelector('.rv-diff-scroll')?.classList.toggle('rv-wrap',session.wrap);queueAlignment(session);return;}
      if(data.reviewAction==='export'){download('pr-reading-progress-'+review.head.slice(0,12)+'.json',JSON.stringify(snapshot(session),null,2),'application/json');return;}
      if(data.reviewAction==='import'){root.querySelector('[data-review-import-file]').click();return;}
      if(data.reviewAction==='save-html')saveHtml(session);
    };
    root.onpointerup=event=>{
      if(event.target.closest('.rv-diff-scroll'))requestAnimationFrame(()=>{if(root.isConnected)selectTextRows(session,event.ctrlKey||event.metaKey);});
    };
    root.onsubmit=event=>{
      if(event.target.matches('[data-review-range-form]')){event.preventDefault();selectLineRange(session,event.target);}
    };
    root.addEventListener('scroll',event=>{
      syncReviewScroll(session,event.target);
      if(event.target.matches?.('.rv-diff-scroll,.rv-note-body')&&rememberPosition(session)){
        clearTimeout(session.positionTimer);session.positionTimer=setTimeout(()=>persist(session),200);
      }
    },true);
    if(!session.flushPosition){
      session.flushPosition=()=>persist(session);
      window.addEventListener('pagehide',session.flushPosition);
    }
    const hoveredId=target=>{const item=target?.closest?.('[data-review-note-card],[data-review-row]');return item?.dataset.reviewNoteCard||item?.dataset.reviewRow||null;};
    root.onpointerover=event=>{const id=hoveredId(event.target);if(id!==session.hoverRow){session.hoverRow=id;updateLineIndicators(session);}};
    root.onpointerout=event=>{const id=hoveredId(event.relatedTarget);if(id!==session.hoverRow){session.hoverRow=id;updateLineIndicators(session);}};
    root.addEventListener('focusin',event=>{const id=event.target.closest('[data-review-note-card]')?.dataset.reviewNoteCard;if(id){session.activeRow=id;session.hoverRow=null;updateLineIndicators(session);persist(session);}});
    if(!root.reviewNotesObserver){
      let size='';
      root.reviewNotesObserver=new ResizeObserver(()=>{
        if(!root.isConnected){root.reviewNotesObserver.disconnect();return;}
        const code=root.querySelector('.rv-diff-scroll');
        const next=[root.clientWidth,root.clientHeight,code?.clientWidth,code?.clientHeight,root.querySelector('[data-review-notes]')?.clientWidth].join(':');
        if(next!==size){size=next;resizeNotes(session);}
      });
      root.reviewNotesObserver.observe(root);
    }
    root.oninput=event=>{
      const target=event.target;
      if(target.matches('[data-review-filter]')){session.filter=target.value;root.querySelector('[data-review-file-list]').innerHTML=fileList(session);return;}
      if(target.matches('[data-review-note]')){
        setEntry(session,target.dataset.reviewNote,{note:target.value});persist(session);
        root.querySelector(`[data-review-note-toggle="${target.dataset.reviewNote}"]`)?.classList.toggle('has-note',Boolean(target.value));
        root.querySelector(`[data-review-row="${target.dataset.reviewNote}"]`)?.classList.toggle('rv-annotated',Boolean(target.value));
        resizeNote(target);queueAlignment(session);
        root.querySelector('[data-review-note-count]').textContent=allRows(currentFile(session)).filter(row=>session.entries[row.id]?.note).length;
      }
    };
    root.onchange=async event=>{
      const target=event.target;
      if(target.matches('[data-review-import-file]')&&target.files[0]){
        try{const incoming=validateBackup(JSON.parse(await target.files[0].text()),session);for(const [id,entry] of Object.entries(incoming.entries))setEntry(session,id,{status:entry.status,note:entry.note});for(const [id,position] of Object.entries(incoming.positions))session.filePositions[id]={...position,updated_at:Math.max(Date.now(),(session.filePositions[id]?.updated_at||0)+1)};session.activeFile=incoming.active_file||session.activeFile;session.activeRow=incoming.active_row;session.draftRow=null;session.hoverRow=null;session.selected.clear();activeRow(session);render(session);persist(session);if(session.level==='normal')session.message='已导入并保存 '+Object.keys(incoming.entries).length+' 处标记/批注。';showSaveState(session);}catch(error){session.message='导入失败：'+error.message;session.level='warning';showSaveState(session);}finally{target.value='';}
      }
    };
  }
  window.CodeReadingReview={mount};
})();
