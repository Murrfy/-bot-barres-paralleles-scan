self.addEventListener('install',()=>self.skipWaiting());

self.addEventListener('activate',event=>{
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push',event=>{
  let payload={};
  try{payload=event.data?event.data.json():{}}catch{
    payload={title:'Zenith',body:'Alerte Zenith',data:{url:'/'}};
  }
  const title=String(payload.title||'Zenith');
  const options={
    body:String(payload.body||''),
    tag:String(payload.tag||'zenith-alert'),
    renotify:true,
    data:payload.data&&typeof payload.data==='object'?payload.data:{url:'/'},
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=new URL(String(event.notification?.data?.url||'/'),self.location.origin).href;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      if(new URL(client.url).origin===self.location.origin){
        await client.focus();
        if('navigate' in client&&client.url!==target)await client.navigate(target);
        return;
      }
    }
    if(self.clients.openWindow)await self.clients.openWindow(target);
  })());
});
