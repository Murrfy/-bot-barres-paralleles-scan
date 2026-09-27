self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));

async function fetchZenithMessages(){
  try{
    const response=await fetch('/api/zenith-sync?action=push-message',{
      method:'GET',
      credentials:'include',
      cache:'no-store',
      headers:{Accept:'application/json'},
    });
    const data=await response.json().catch(()=>({}));
    if(response.ok&&data?.ok===true&&Array.isArray(data.messages)&&data.messages.length){
      return data.messages;
    }
  }catch{}
  return [{
    title:'⚠️ ZENITH — ALERTE MAX-LOSS',
    body:'Ouvre Zenith pour vérifier la protection.',
    tag:'zenith-maxloss-fallback',
    level:'warning',
  }];
}

self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    const messages=await fetchZenithMessages();
    for(const message of messages){
      await self.registration.showNotification(String(message?.title||'ZENITH'),{
        body:String(message?.body||''),
        tag:String(message?.tag||'zenith-maxloss'),
        renotify:true,
        data:{url:'/'},
      });
    }
  })());
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      if('focus' in client){
        await client.focus();
        return;
      }
    }
    if(self.clients.openWindow)await self.clients.openWindow('/');
  })());
});
