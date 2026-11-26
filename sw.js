const CACHE='myglobe-v5';
const CORE=['./','./index.html','./style.css','./app.js','./data/countries.json','./data/world.bin','./data/features.js','./data/flags.js','./icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
// stale-while-revalidate: instant from cache, refreshed in the background for next visit
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  e.respondWith(caches.open(CACHE).then(async c=>{
    const hit=await c.match(e.request);
    const net=fetch(e.request).then(r=>{if(r&&(r.ok||r.type==='opaque'))c.put(e.request,r.clone()).catch(()=>{});return r}).catch(()=>hit);
    return hit||net;
  }));
});
