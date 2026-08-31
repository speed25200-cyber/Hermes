// ---- Legacy guard: provide Exec.checkClosed in renderer ----
try{
  globalThis.Exec = globalThis.Exec || {};
  if(typeof globalThis.Exec.checkClosed !== 'function'){
    globalThis.Exec.checkClosed = async function(){ return true; };
  }
}catch(e){}

