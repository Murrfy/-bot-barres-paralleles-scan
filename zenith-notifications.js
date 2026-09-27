(()=>{
'use strict';

const button=()=>document.getElementById('pushAlertBtn');
const status=()=>document.getElementById('pushAlertStatus');
let registrationPromise=null;
let active=false;

function bytes(value){
  const text=String(value||'').replace(/-/g,'+').replace(/_/g,'/');
  const padded=text+'='.repeat((4-text.length%4)%4);
  const raw=atob(padded),out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}
function supported(){
  return 'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
}
function iosNeedsHomeScreen(){
  if(!/iPhone|iPad|iPod/i.test(navigator.userAgent))return false;
  return !(window.matchMedia?.('(display-mode: standalone)')?.matches||navigator.standalone===true);
}
function sameKey(subscription,publicKey){
  const current=subscription?.options?.applicationServerKey;
  if(!current)return true;
  const a=new Uint8Array(current),b=bytes(publicKey);
  if(a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
  return true;
}
async function registration(){
  if(!supported())throw new Error('PUSH_NON_PRIS_EN_CHARGE');
  if(!registrationPromise){
    registrationPromise=navigator.serviceWorker.register('/zenith-sw.js',{scope:'/'})
      .then(()=>navigator.serviceWorker.ready)
      .catch(error=>{registrationPromise=null;throw error});
  }
  return registrationPromise;
}
async function api(action,{method='GET',body}={}){
  const response=await fetch('/api/zenith-push?action='+encodeURIComponent(action),{
    method,
    cache:'no-store',
    headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{})},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data?.ok!==true)throw new Error(data?.code||('HTTP_'+response.status));
  return data;
}
async function refresh(){
  const btn=button(),label=status();
  if(!btn||!label)return;
  active=false;
  if(!supported()){
    btn.disabled=true;
    label.textContent='Notifications non prises en charge sur cet appareil.';
    return;
  }
  if(iosNeedsHomeScreen()){
    btn.disabled=false;
    btn.textContent='Activer notifications';
    label.textContent='Sur iPhone, ouvre Zenith depuis l’écran d’accueil pour activer les notifications.';
    return;
  }
  try{
    const reg=await registration();
    const [subscription,config]=await Promise.all([reg.pushManager.getSubscription(),api('config')]);
    active=Boolean(subscription&&config.subscribed&&Notification.permission==='granted'&&sameKey(subscription,config.publicKey));
    btn.disabled=false;
    btn.textContent=active?'Désactiver notifications':'Activer notifications';
    if(active){
      label.textContent='Alerte active : notification après '+Math.round(Number(config.thresholdSeconds)||60)+' s de MAX-LOSS rouge continu.';
    }else if(Notification.permission==='denied'){
      label.textContent='Notifications refusées dans les réglages iPhone.';
    }else{
      label.textContent='Aucune notification MAX-LOSS active.';
    }
  }catch(error){
    btn.disabled=false;
    btn.textContent='Activer notifications';
    label.textContent='Notifications Zenith indisponibles : '+String(error?.message||'erreur')+'.';
  }
}
async function toggle(){
  const btn=button(),label=status();
  if(!btn||!label)return;
  if(iosNeedsHomeScreen()){
    label.textContent='Ajoute/ouvre Zenith depuis l’écran d’accueil, puis appuie à nouveau sur ce bouton.';
    return;
  }
  btn.disabled=true;
  try{
    const reg=await registration();
    let subscription=await reg.pushManager.getSubscription();
    if(active&&subscription){
      await api('unsubscribe',{method:'POST',body:{endpoint:subscription.endpoint}});
      await subscription.unsubscribe();
      active=false;
      label.textContent='Notifications MAX-LOSS désactivées.';
      return;
    }

    const permission=await Notification.requestPermission();
    if(permission!=='granted'){
      label.textContent=permission==='denied'
        ?'Notifications refusées dans les réglages iPhone.'
        :'Autorisation de notification non accordée.';
      return;
    }

    const config=await api('config');
    if(subscription&&!sameKey(subscription,config.publicKey)){
      await subscription.unsubscribe();
      subscription=null;
    }
    if(!subscription){
      subscription=await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:bytes(config.publicKey),
      });
    }
    await api('subscribe',{method:'POST',body:{subscription:subscription.toJSON()}});
    active=true;
    label.textContent='Alerte active : notification après '+Math.round(Number(config.thresholdSeconds)||60)+' s de MAX-LOSS rouge continu.';
  }catch(error){
    label.textContent='Activation impossible : '+String(error?.message||'erreur')+'.';
  }finally{
    btn.disabled=false;
    await refresh();
  }
}

function init(){
  const btn=button();
  if(btn)btn.addEventListener('click',toggle);
  void refresh();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
else init();
})();
