import * as pdfjs from './pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./pdf.worker.mjs',import.meta.url).href;
const worker=new Worker(new URL('./worker.js'+new URL(import.meta.url).search,import.meta.url));
let sequence=0;
const pending=new Map(), urls=new Map();
worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};
worker.onerror=()=>{for(const p of pending.values())p.reject(new Error('Өңдеу модулінде қате шықты. Бетті жаңартыңыз.'));pending.clear();};
function rpc(action,data={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({id,action,data});});}
function dropUrls(keepIds=[]){for(const [key,url] of urls)if(!keepIds.includes(key.split(':')[0])){URL.revokeObjectURL(url);urls.delete(key);}}
async function imageUrl(page,original=false,thumb=false){
  const key=`${page.id}:${page.rotation}:${original}:${thumb}`;
  if(urls.has(key))return urls.get(key);
  const result=await rpc('image',{id:page.id,original,thumb});
  const url=URL.createObjectURL(new Blob([result.bytes],{type:result.mime}));
  urls.set(key,url);return url;
}
async function withImages(state){
  if(!state.pages)return state;
  dropUrls(state.pages.map(p=>p.id));
  for(const page of state.pages)page.thumb=await imageUrl(page,false,true);
  return state;
}
async function rasterPdf(data){
  let document;
  try{
    document=await pdfjs.getDocument({data:data.slice(),isEvalSupported:false,useSystemFonts:true,disableFontFace:false,wasmUrl:new URL('./',import.meta.url).href}).promise;
    if(document.numPages<1||document.numPages>40)throw new Error('PDF құжатында 1–40 бет болуы керек.');
    const rasters=[];let total=0;
    for(let i=1;i<=document.numPages;i++){
      const page=await document.getPage(i), base=page.getViewport({scale:1});
      const view=page.getViewport({scale:2400/Math.max(base.width,base.height)});
      const canvas=documentCanvas(Math.ceil(view.width),Math.ceil(view.height));
      await page.render({canvasContext:canvas.getContext('2d'),viewport:view}).promise;
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if(!blob)throw new Error('PDF бетін суретке айналдыру мүмкін болмады.');
      total+=blob.size;if(total>192*1048576)throw new Error('PDF көріністері тым үлкен. Құжатты шағын бөліктермен қосыңыз.');
      rasters.push(new Uint8Array(await blob.arrayBuffer()));canvas.width=canvas.height=1;page.cleanup();
    }
    return rasters;
  }catch(error){
    if(error.name==='PasswordException')throw new Error('Құпиясөзбен қорғалған PDF қолдау таппайды.');
    if(/PDF құжатында|тым үлкен|айналдыру/.test(error.message))throw error;
    throw new Error('PDF ашылмады: файл бүлінген немесе пішімі дұрыс емес.');
  }finally{await document?.destroy();}
}
function documentCanvas(width,height){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;return canvas;}
async function upload(file,target){
  if(file.size>64*1048576)throw new Error('Бір файлдың көлемі 64 МиБ-тан аспауы керек.');
  const current=await rpc('state');
  if(current.sourceBytes+file.size>96*1048576)throw new Error('Сессиядағы файлдардың жалпы шегі — 96 МиБ.');
  const bytes=new Uint8Array(await file.arrayBuffer());let rasters=[];
  if(file.name.toLowerCase().endsWith('.pdf')){
    if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('Файлдың мазмұны PDF түріне сәйкес емес.');
    rasters=await rasterPdf(bytes);
  }
  return rpc('upload',{name:file.name,data:bytes,rasters,replace:target||null});
}
export const engine={
  async request(path,body){
    const url=new URL(path,location.origin), action=url.pathname.split('/').pop();
    let result;
    if(action==='upload'){
      result=await upload(body.get('files'),url.searchParams.get('replace'));
    }else if(action==='demo'){
      let issues=[],added=0;
      for(const name of ['01-upright.png','02-sideways.png','03-upside-down.png','04-blurry.png']){
        const response=await fetch('./'+name);if(!response.ok)throw new Error('Демо бет жүктелмеді: '+name);
        result=await upload(new File([await response.blob()],name),null);added+=result.added;issues.push(...result.errors);
      }
      result.added=added;result.errors=issues;
    }else result=await rpc(action,body||{});
    return withImages(result);
  },
  preview(page,original){return imageUrl(page,original,false);},
  async download(path){
    const url=new URL(path,location.origin), data=Object.fromEntries(url.searchParams), action=url.pathname.split('/').pop();
    const result=await rpc(action,data);return new Blob([result.bytes],{type:result.mime});
  },
  // Used by the separately shipped synthetic regression page, never by a remote service.
  evaluate(fixtures){return rpc('evaluate',{fixtures});}
};
