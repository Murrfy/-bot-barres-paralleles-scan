(()=>{
'use strict';
const button=document.getElementById('maxLossNotificationsBtn');
const box=document.getElementById('maxLossNotificationsStatus');
if(!button||!box)return;

let enabled=false;
let busy=false;

function setStatus(message,type=''){
  box.textContent=message;
  box.className='status'+(type?' '+type:'');
}
function standalone(){
  return window.matchMedia?.('(display-mode: standalone)')?.matches===true||
    window.navigator.standalone===true;
}
function applicationServerKey(value){
  const pad='='.repeat((4-(value.length%4))%4);
  const base64=(value+pad).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  return Uint8Array.from(raw,ch=>ch.charCodeAt(0));
}
async function api(action,{method='GET',body}={}){
  const response=await fetch('/api/zenith-sync?action='+encodeURIComponent(action),{
    method,
    credentials:'include',
    cache:'no-store',
    headers:{
      Accept:'application/json',
      ...(body!==undefined?{'Content-Type':'application/json'}:{}),
    },
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data?.ok!==true){
    const error=new Error(String(data?.code||('HTTP_'+response.status)));
    error.status=response.status;
    throw error;
  }
  return data;
}
async function registration(){
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)){
    throw new Error('PUSH_NON_SUPPORTE');
  }
  await navigator.serviceWorker.register('/sw.js',{scope:'/'});
  return navigator.serviceWorker.ready;
}
function render(){
  button.disabled=busy;
  button.textContent=enabled?'Désactiver les notifications MAX-LOSS':'Activer les notifications MAX-LOSS';
}
async function refresh(){
  if(!standalone()){
    enabled=false;
    setStatus('Notifications iPhone : ajoute Zenith à l’écran d’accueil puis ouvre-le depuis son icône.','warn');
    render();
    return;
  }
  try{
    const reg=await registration();
    const local=await reg.pushManager.getSubscription();
    const server=await api('push-status');
    enabled=Boolean(local&&server.enabled===true&&Notification.permission==='granted');
    setStatus(
      enabled?'Notifications MAX-LOSS : ACTIVÉES':'Notifications MAX-LOSS : non activées.',
      enabled?'ok':'warn'
    );
  }catch(error){
    if(Number(error?.status)===401||Number(error?.status)===409){
      setStatus('Notifications MAX-LOSS : vérification du contrôleur en cours.','warn');
    }else{
      setStatus('Notifications MAX-LOSS indisponibles : '+String(error?.message||'erreur')+'.','err');
    }
    enabled=false;
  }
  render();
}
async function activate(){
  if(!standalone())throw new Error('AJOUT_ECRAN_ACCUEIL_REQUIS');
  const reg=await registration();
  const prepared=await api('push-prepare',{method:'POST',body:{}});
  const permission=await Notification.requestPermission();
  if(permission!=='granted')throw new Error('AUTORISATION_NOTIFICATION_REFUSEE');
  let subscription=await reg.pushManager.getSubscription();
  if(!subscription){
    subscription=await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:applicationServerKey(String(prepared.publicKey||'')),
    });
  }
  await api('push-subscribe',{
    method:'POST',
    body:{subscription:subscription.toJSON()},
  });
  enabled=true;
  setStatus('Notifications MAX-LOSS : ACTIVÉES. Envoi du test…','ok');
  render();
  await api('push-test',{method:'POST',body:{}});
  setStatus('Notifications MAX-LOSS : ACTIVÉES — test envoyé.','ok');
}
async function deactivate(){
  const reg=await registration();
  const subscription=await reg.pushManager.getSubscription();
  if(subscription)await subscription.unsubscribe().catch(()=>false);
  await api('push-unsubscribe',{method:'POST',body:{}});
  enabled=false;
  setStatus('Notifications MAX-LOSS : désactivées.','warn');
  render();
}
button.addEventListener('click',async()=>{
  if(busy)return;
  busy=true;render();
  try{
    if(enabled)await deactivate();else await activate();
  }catch(error){
    setStatus('Notifications MAX-LOSS : '+String(error?.message||'erreur')+'.','err');
  }finally{
    busy=false;render();
  }
});
render();
setTimeout(()=>refresh().catch(()=>{}),1200);
})();
