import {engine} from '../web/engine.js?v=6';
import * as pdfjs from '../vendor/pdfjs/pdf.mjs';
const output=document.getElementById('result');
function assert(value,message){if(!value)throw Error(message);}
async function fixture(name){
  const response=await fetch(new URL('./qa-fixtures/'+name,import.meta.url));
  if(!response.ok)throw Error('Сынақ файлы табылмады: '+name+'. README нұсқаулығымен архивті ашыңыз.');
  return response;
}
async function file(name){return new File([await (await fixture(name)).blob()],name);}
async function upload(f){const body=new FormData();body.append('files',f);return engine.request('/api/upload',body);}
async function pdf(blob){return pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer())}).promise;}
document.getElementById('run').onclick=async()=>{
  document.getElementById('run').disabled=true;
  const report={};
  try{
    output.textContent='Демо тексеріліп жатыр…';
    let s=await engine.request('/api/state');
    s=await engine.request('/api/demo',{});assert(s.pages.length===4,'4 демо бет');
    assert(JSON.stringify(s.pages.slice(0,3).map(p=>p.rotation))==='[0,270,180]','Бағыт');
    assert(s.pages[3].notes.some(n=>n.includes('Бұлыңғыр')),'Бұлыңғыр');
    s=await engine.request('/api/delete',{id:s.pages[3].id});
    s=await engine.request('/api/reorder',{ids:[s.pages[2].id,s.pages[0].id,s.pages[1].id]});
    let c=await engine.request('/api/compare',{range:'',limit:'0,23'});
    report.sizes=c.sizes;assert(c.recommended==='standard','Орташа ұсынысы');
    let blob=await engine.download('/api/pdf?'+new URLSearchParams({mode:'standard',revision:c.revision,range:''}));
    assert(blob.size===c.sizes.standard,'Нақты байт саны');
    let doc=await pdf(blob);assert(doc.numPages===3,'3 беттік PDF');await doc.destroy();
    s=await upload(new File([blob],'roundtrip.pdf'));assert(s.pages.length===6,'PDF қайта қосу');
    c=await engine.request('/api/compare',{range:'4, 6',limit:'5'});
    blob=await engine.download('/api/pdf?'+new URLSearchParams({mode:'original',revision:c.revision,range:'4, 6'}));
    doc=await pdf(blob);assert(doc.numPages===2,'Аралық PDF');await doc.destroy();
    for(const format of ['jpg','png']){
      const b=await engine.download('/api/image?'+new URLSearchParams({id:s.pages[3].id,format}));
      const decoded=await createImageBitmap(b);assert(decoded.width>100&&decoded.height>100,format);decoded.close();
    }
    s=await upload(await file('text-source.pdf'));assert(s.pages.length===7,'Мәтінді PDF');
    c=await engine.request('/api/compare',{range:'7',limit:'5'});
    blob=await engine.download('/api/pdf?'+new URLSearchParams({mode:'original',revision:c.revision,range:'7'}));
    doc=await pdf(blob);const text=(await (await doc.getPage(1)).getTextContent()).items.map(i=>i.str).join(' ');
    assert(text.includes('FILELAB SELECTABLE TEXT'),'Мәтінді сақтау');report.preservedText=text;await doc.destroy();
    for(const name of ['broken.pdf','too-many-pages.pdf']){
      let rejected=false;try{const r=await upload(await file(name));rejected=!!r.errors?.length;}catch{rejected=true;}assert(rejected,name);
    }
    assert((await engine.request('/api/state')).pages.length===7,'Беттер сақталды');
    c=await engine.request('/api/compare',{range:'',limit:'0,0001'});assert(!c.recommended,'Ешбірі сыймайды');
    s=await engine.request('/api/clear',{});assert(!s.pages.length,'Тазарту');
    report.functionalChecks='passed';
    output.textContent='192 тест суреті өлшеніп жатыр…';
    const manifest=await (await fixture('manifest.json')).json();
    const fixtures=[];
    for(const item of manifest){const response=await fixture(item.name);fixtures.push({...item,data:new Uint8Array(await response.arrayBuffer())});}
    const evaluation=await engine.evaluate(fixtures);
    report.model={correct:evaluation.correct,total:evaluation.total,matrix:evaluation.matrix};
    assert(evaluation.correct===144,'Модель 144/192');
    report.passed=true;
    output.textContent=JSON.stringify(report,null,2);
    const a=document.createElement('a');a.textContent='Тексеру есебін жүктеу';a.download='browser-verification.json';a.href=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));document.body.append(a);
  }catch(error){output.textContent=JSON.stringify({...report,passed:false,error:error.message,stack:error.stack},null,2);}
};
