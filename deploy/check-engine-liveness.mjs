const enabled=process.env.ZENITH_ENGINE_WORKER_ENABLED==='1';
if(!enabled)process.exit(0);

const raw=Number(process.env.ZENITH_ENGINE_HEALTH_PORT||8787);
const port=Number.isInteger(raw)&&raw>=1&&raw<=65535?raw:8787;

try{
  const response=await fetch(`http://127.0.0.1:${port}/healthz`,{
    signal:AbortSignal.timeout(5000),
    cache:'no-store',
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data?.ok!==true||data?.enabled!==true){
    throw new Error('ENGINE_LIVENESS_FAILED');
  }
  process.exit(0);
}catch(error){
  console.error(String(error?.message||error||'ENGINE_LIVENESS_FAILED'));
  process.exit(1);
}
