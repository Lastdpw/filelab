import {engine} from './engine.js?v=6';
'use strict';
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {original:'Жоғары сапа',standard:'Орташа',small:'Шағын файл'};
const photoDefaults = {preset:'color', brightness:0, contrast:0, sharpness:0};
const photoSliders = ['brightness','contrast','sharpness'];
let state={pages:[],revision:0,token:''}, selected=null, original=false, mode='original', comparison=null, busy=false, timer=null, comparisonVersion=0, previewVersion=0;
const MB = 1_000_000;
const megabytes = (n,digits=3) => `${(n/MB).toFixed(digits).replace('.',',')} МБ`;
const bytes = n => `${megabytes(n)} · ${n.toLocaleString('kk-KZ')} байт`;
const sourceLimitHint = $('sourceTotal').textContent;
function status(text){$('status').textContent=text;}
function errors(messages=[]){$('errors').hidden=!messages.length;$('errors').textContent=messages.join('\n');}
async function request(path,body){return engine.request(path,body);}
async function task(message, fn){
  if(busy)return;
  busy=true;$('photoTools').disabled=true;document.body.classList.add('busy');$('status').classList.add('busy');$('workspace').setAttribute('aria-busy','true');status(message);errors();
  try {await fn();} catch(error){errors([error.message]);status('Әрекет аяқталмады. Бұрын қосылған беттер сақталды.');}
  finally{busy=false;$('photoTools').disabled=false;document.body.classList.remove('busy');$('status').classList.remove('busy');$('workspace').setAttribute('aria-busy','false');}
}
function accept(data){
  state=data;
  if(!state.pages.some(p=>p.id===selected))selected=state.pages[0]?.id||null;
  original=false;comparison=null;comparisonVersion++;render();errors(data.errors||[]);
}
function imageUrl(page){return page.thumb;}
function render(){
  $('count').textContent=state.pages.length;
  $('sourceTotal').textContent=state.pages.length?`${state.pages.length}/40 бет · бастапқы файлдар: ${megabytes(state.sourceBytes,2)}`:sourceLimitHint;
  $('clear').disabled=!state.pages.length;$('compare').disabled=!state.pages.length;
  $('pages').innerHTML=state.pages.map((p,i)=>`<article class="page-card ${selected===p.id?'selected':''}" draggable="false" data-id="${p.id}" tabindex="0" role="button" aria-label="${i+1}-бет: ${escapeHtml(p.title)}" aria-pressed="${selected===p.id}"><span class="page-number">${String(i+1).padStart(2,'0')}</span><img draggable="false" class="thumb" src="${imageUrl(p,true)}" alt="${i+1}-бет нобайы"><div class="card-body"><span class="card-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span><span class="badge ${p.notes.length||p.orientation==='Қолмен тексеріңіз'?'warn':''}">${p.notes.length?'⚠ '+escapeHtml(p.notes.join(', ')):p.orientation==='Қолмен тексеріңіз'?'⚠ Қолмен тексеріңіз':'✓ '+escapeHtml(p.orientation)}</span></div><div class="order-actions"><button class="remove" data-action="delete" aria-label="${i+1}-бетті алып тастау">Өшіру</button><button data-action="up" aria-label="${i+1}-бетті жоғары жылжыту" ${i===0?'disabled':''}>↑</button><button data-action="down" aria-label="${i+1}-бетті төмен жылжыту" ${i===state.pages.length-1?'disabled':''}>↓</button></div></article>`).join('');
  renderPreview();renderPhotoTools();renderModes();
}
function photoDiffers(first,second){
  return Object.keys(photoDefaults).some(key=>first[key]!==second[key]);
}
function readPhotoControls(){
  const edits={preset:$('photoPreset').value};
  for(const key of photoSliders)edits[key]=$(key).valueAsNumber;
  return edits;
}
function refreshPhotoButtons(){
  const applied=state.pages.find(page=>page.id===selected)?.photo;
  if(!applied)return;
  const draft=readPhotoControls();
  for(const key of photoSliders)$(key+'Value').value=draft[key];
  $('applyPhoto').disabled=!photoDiffers(draft,applied);
  $('resetPhoto').disabled=!photoDiffers(draft,photoDefaults)&&!photoDiffers(applied,photoDefaults);
}
function renderPhotoTools(){
  const photo=state.pages.find(page=>page.id===selected)?.photo;
  $('photoTools').hidden=!photo;
  if(!photo)return;
  $('photoPreset').value=photo.preset;
  for(const key of photoSliders)$(key).value=photo[key];
  refreshPhotoButtons();
}
function renderPreview(){
  const version=++previewVersion;
  const p=state.pages.find(p=>p.id===selected), index=state.pages.indexOf(p);
  const edited=!!p?.photo&&photoDiffers(p.photo,photoDefaults);
  $('empty').hidden=!!p;$('preview').hidden=!p;$('views').hidden=!p||(!p.rotation&&!edited);
  $('original').classList.toggle('active',original);$('corrected').classList.toggle('active',!original);
  ['left','right','quality','orient','replace','jpg','png'].forEach(id=>$(id).disabled=!p);
  $('pagePosition').textContent=p?`${index+1} / ${state.pages.length} бет`:'Әзірге бет жоқ';
  $('pageTitle').textContent=p?p.title:'Бет таңдалмады';
  $('previewLabel').textContent=p?(original?'Бастапқы көрініс':`${p.kind} · бұрылыс ${p.rotation}°`):'Сіздің жұмыс кеңістігіңіз';
  $('pageNotes').textContent=p?[p.orientation,...p.notes,`Модель дауысы: ${Math.round(p.vote*100)}%`].join(' · '):'Суреттер мен PDF беттері осында көрсетіледі.';
  if(p){
    engine.preview(p,original).then(url=>{if(version===previewVersion)$('preview').src=url;})
      .catch(error=>{if(version===previewVersion)errors([error.message]);});
    $('preview').alt=`${index+1}-бет: ${p.title}, ${original?'бастапқы':'ағымдағы'} көрініс`;
  }
  else $('preview').removeAttribute('src');
}
function renderModes(){
  $('modes').innerHTML=Object.entries(labels).map(([key,label])=>`<button class="mode ${mode===key?'selected':''}" role="radio" aria-checked="${mode===key}" data-mode="${key}"><span class="radio"></span><span class="mode-name">${label}${comparison?.recommended===key?'<span class="suggested">ҰСЫНЫЛАДЫ</span>':''}</span><span class="mode-detail">${comparison?`${bytes(comparison.sizes[key])}<br><span class="${comparison.fits[key]?'fit':'over'}">${comparison.fits[key]?'✓ Шекке сыяды':'⚠ Шектен асады'}</span>`:key==='original'?'PDF мәтіні сақталады · көлемі есептелмеді':'PDF беттері суретке айналады · есептелмеді'}</span></button>`).join('');
  $('download').disabled=!comparison;
  const warning=!!comparison&&(!comparison.recommended||!comparison.fits[mode]);
  $('recommendation').classList.toggle('warning',warning);
  $('recommendation').textContent=!comparison?'Нақты көлемді көру үшін «Көлемдерді салыстыру» батырмасын басыңыз.':!comparison.recommended?'⚠ Үш нұсқа да шектен асады. Бет аралығын азайтыңыз немесе көлем шегін өзгертіңіз.':!comparison.fits[mode]?'⚠ Таңдалған режим шектен асады. Ұсынылған режимді таңдаңыз.':`✓ ${labels[comparison.recommended]} — осы шекке сыятын ең жоғары сапа.`;
  $('download').textContent=comparison&&!comparison.fits[mode]?'↓ Шектен асатын PDF жүктеу':'↓ PDF жүктеу';
  $('exportCount').textContent=comparison?`${comparison.count} бет · ${bytes(comparison.sizes[mode])}`:'Барлық бет бір файлда';
}
async function compare(){
  if(!state.pages.length)return;
  const version=comparisonVersion, spec=$('range').value, limit=$('limit').value;
  const result=await request('/api/compare',{range:spec,limit});
  if(version!==comparisonVersion||spec!==$('range').value||limit!==$('limit').value)return;
  comparison=result;mode=result.recommended||mode;renderModes();
  status(result.recommended?`Үш PDF дайын. Ұсынылған режим: ${labels[result.recommended]}.`:'Үш нұсқа да берілген көлем шегінен асады.');
}
async function changed(path,data){await task('Беттер өңделіп жатыр…',async()=>{accept(await request(path,data));status('Беттер жаңартылды.');if(state.pages.length)await compare();});}
async function upload(files,target=null){
  const list=[...files];if(!list.length)return;
  await task('Файлдар қосылып, бағыты мен сапасы тексеріліп жатыр…',async()=>{
    let issues=[],added=0;
    for(const file of list){
      const body=new FormData();body.append('files',file);
      try{
        const position=target?state.pages.findIndex(page=>page.id===target):state.pages.length;
        const result=await request('/api/upload'+(target?'?replace='+encodeURIComponent(target):''),body);
        if(result.added&&!added)selected=result.pages[position].id;
        added+=result.added;issues.push(...result.errors);accept(result);
      }catch(e){issues.push(`${file.name}: ${e.message}`);}
    }
    if(state.pages.length)await compare();errors(issues);status(`${added} бет ${target?'ауыстырылды':'қосылды'}. Барлығы ${state.pages.length} бет.${issues.length?' Кей файлдар қосылмады.':''}`);
  });
}
function select(id){selected=id;original=false;render();}
async function reorder(id,index){const ids=state.pages.map(p=>p.id), from=ids.indexOf(id);if(from<0||index<0||index>=ids.length||from===index)return;ids.splice(index,0,ids.splice(from,1)[0]);await changed('/api/reorder',{ids});}
async function download(url, name){
  await task('Файл жүктеуге дайындалып жатыр…',async()=>{
    const blob=await engine.download(url), link=document.createElement('a'), objectUrl=URL.createObjectURL(blob);
    link.href=objectUrl;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),30000);
    status(`${name} жүктелді · ${bytes(blob.size)}.`);
  });
}
['add','emptyAdd','dropzone'].forEach(id=>$(id).onclick=()=>{if(!busy)$('fileInput').click();});
$('fileInput').onchange=async e=>{await upload(e.target.files);e.target.value='';};
$('replace').onclick=()=>{if(!busy)$('replaceInput').click();};
$('replaceInput').onchange=async e=>{await upload(e.target.files,selected);e.target.value='';};
$('demo').onclick=()=>changed('/api/demo',{});
$('clear').onclick=()=>changed('/api/clear',{});
$('left').onclick=()=>changed('/api/rotate',{id:selected,angle:-90});
$('right').onclick=()=>changed('/api/rotate',{id:selected,angle:90});
$('quality').onclick=()=>changed('/api/quality',{id:selected});
$('orient').onclick=()=>changed('/api/orient',{id:selected});
$('photoTools').oninput=refreshPhotoButtons;
$('applyPhoto').onclick=()=>changed('/api/photo-filter',{id:selected,...readPhotoControls()});
$('resetPhoto').onclick=()=>changed('/api/photo-filter',{id:selected,...photoDefaults});
$('original').onclick=()=>{original=true;renderPreview();};$('corrected').onclick=()=>{original=false;renderPreview();};
$('compare').onclick=()=>task('Үш PDF нұсқасының нақты көлемі есептеліп жатыр…',compare);
$('modes').onclick=e=>{const button=e.target.closest('[data-mode]');if(button&&!busy){mode=button.dataset.mode;renderModes();}};
for(const id of ['range','limit'])$(id).addEventListener('input',()=>{
  comparison=null;comparisonVersion++;renderModes();clearTimeout(timer);
  const update=()=>{if(busy){timer=setTimeout(update,250);return;}task('Көлемдер жаңартылып жатыр…',compare);};timer=setTimeout(update,500);
});
$('download').onclick=()=>{if(comparison)download('/api/pdf?'+new URLSearchParams({mode,range:comparison.range,revision:comparison.revision}),`FileLab-${mode}.pdf`);};
for(const format of ['jpg','png'])$(format).onclick=()=>{if(selected)download('/api/image?'+new URLSearchParams({id:selected,format}),`FileLab-page.${format}`);};
$('pages').onclick=e=>{if(busy)return;const card=e.target.closest('[data-id]');if(!card)return;const id=card.dataset.id, action=e.target.closest('[data-action]')?.dataset.action;if(action==='delete')changed('/api/delete',{id});else if(action==='up'||action==='down')reorder(id,state.pages.findIndex(p=>p.id===id)+(action==='up'?-1:1));else select(id);};
$('pages').onkeydown=e=>{if(e.target.matches('.page-card')&&['Enter',' '].includes(e.key)){e.preventDefault();select(e.target.dataset.id);}};
let pageDrag=null;
$('pages').onpointerdown=e=>{
  const card=e.target.closest('.page-card');
  if(busy||e.button!==0||e.pointerType==='touch'||!card||e.target.closest('button'))return;
  pageDrag={id:card.dataset.id,x:e.clientX,y:e.clientY,moved:false,pointer:e.pointerId};
  $('pages').setPointerCapture(e.pointerId);
};
$('pages').onpointermove=e=>{
  if(!pageDrag)return;
  if(Math.hypot(e.clientX-pageDrag.x,e.clientY-pageDrag.y)>8)pageDrag.moved=true;
  if(!pageDrag.moved)return;
  document.querySelectorAll('.drag-over').forEach(c=>c.classList.remove('drag-over'));
  document.elementFromPoint(e.clientX,e.clientY)?.closest('.page-card')?.classList.add('drag-over');
  e.preventDefault();
};
$('pages').onpointerup=e=>{
  if(!pageDrag)return;
  const drag=pageDrag;pageDrag=null;
  if($('pages').hasPointerCapture(e.pointerId))$('pages').releasePointerCapture(e.pointerId);
  document.querySelectorAll('.drag-over').forEach(c=>c.classList.remove('drag-over'));
  const card=document.elementFromPoint(e.clientX,e.clientY)?.closest('.page-card');
  if(drag.moved&&card)reorder(drag.id,state.pages.findIndex(p=>p.id===card.dataset.id));
  else if(!drag.moved)select(drag.id);
};
$('pages').onpointercancel=()=>{pageDrag=null;document.querySelectorAll('.drag-over').forEach(c=>c.classList.remove('drag-over'));};
document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();$('workspace').classList.add('dragging');}});
document.addEventListener('dragleave',e=>{if(!e.relatedTarget)$('workspace').classList.remove('dragging');});
document.addEventListener('drop',e=>{e.preventDefault();$('workspace').classList.remove('dragging');if(e.dataTransfer.files.length)upload(e.dataTransfer.files);});
$('preview').onerror=()=>{errors(['Таңдалған бетті көрсету мүмкін болмады. Сессия аяқталса, файлды қайта қосыңыз.']);};
status('Браузердегі өңдеу модулі жүктеліп жатыр… Алғаш ашқанда біраз уақыт кетеді.');
request('/api/state').then(result=>{
  if(busy)return;
  accept(result);
  status('Өңдеу модулі дайын. Файлдар осы браузерде өңделеді.');
}).catch(error=>{if(!busy)errors([error.message]);});

