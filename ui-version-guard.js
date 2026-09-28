"use strict";
(()=>{
  let documentVersion='';
  let checking=false;

  async function currentDocumentVersion(){
    const response=await fetch(window.location.pathname||'/',{
      method:'HEAD',
      cache:'no-store',
      headers:{Accept:'text/html'}
    });
    if(!response.ok)return '';
    return String(
      response.headers.get('etag')||
      response.headers.get('last-modified')||
      ''
    ).trim();
  }

  async function checkForNewZenithVersion(){
    if(checking)return false;
    checking=true;
    try{
      const next=await currentDocumentVersion();
      if(!next)return false;
      if(!documentVersion){
        documentVersion=next;
        return false;
      }
      if(next!==documentVersion){
        window.location.reload();
        return true;
      }
      return false;
    }catch(_){
      return false;
    }finally{
      checking=false;
    }
  }

  void checkForNewZenithVersion();
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible')void checkForNewZenithVersion();
  });
  window.addEventListener('online',()=>void checkForNewZenithVersion());
  setInterval(()=>{
    if(document.visibilityState==='visible')void checkForNewZenithVersion();
  },60000);
})();
