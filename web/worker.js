/* Python executes inside this browser worker. No user file is sent to a server. */
const workerUrl=new URL(self.location.href);
const pythonRuntime=new URL('../vendor/pyodide/',workerUrl);
importScripts(new URL('pyodide.js',pythonRuntime).href);
let py, dispatch, queue=Promise.resolve();
const ready=(async()=>{
  py=await loadPyodide({indexURL:pythonRuntime.href});
  await py.loadPackage(['numpy','pillow']);
  for(const file of ['pypdf-6.10.0-py3-none-any.whl','reportlab-4.4.9-py3-none-any.whl','charset_normalizer.zip']){
    const response=await fetch(new URL(file,pythonRuntime));if(!response.ok)throw Error('Кітапхана жүктелмеді: '+file);
    py.unpackArchive(await response.arrayBuffer(),'zip',{extractDir:'/home/pyodide'});
  }
  for(const file of ['orientation.py','documents.py','orientation_model.npz','browser_core.py']){
    const url=new URL('../core/'+file,workerUrl);
    url.search=workerUrl.search;
    const response=await fetch(url);if(!response.ok)throw Error('Қолданба файлы жүктелмеді: '+file);
    py.FS.writeFile('/home/pyodide/'+file,new Uint8Array(await response.arrayBuffer()));
  }
  await py.runPythonAsync('from browser_core import dispatch');
  dispatch=py.globals.get('dispatch');
})();
self.onmessage=event=>{
  const {id,action,data}=event.data;
  queue=queue.then(async()=>{
    let input,result;
    try{
      await ready;
      input=py.toPy(data||{});result=dispatch(action,input);
      const value=result?.toJs?result.toJs({dict_converter:Object.fromEntries}):result;
      self.postMessage({id,result:value});
    }catch(error){
      const details=String(error.message||error);
      const value=details.match(/ValueError: ([^\n]+)/)?.[1];
      self.postMessage({id,error:value||'Өңдеу модулі іске қосылмады немесе файлды өңдей алмады. Бетті жаңартып көріңіз.'});
      console.error(error);
    }finally{input?.destroy?.();result?.destroy?.();}
  });
};
