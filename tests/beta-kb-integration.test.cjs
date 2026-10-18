'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(__dirname+'/../PluginLampa-beta.js','utf8');
const storage=new Map(),menus=[],calls=[];let plugin;let simulateFailure=false;
const L={Manifest:{set plugins(p){plugin=p;}},Listener:{follow(){}},
Storage:{get(k,d){return storage.has(k)?storage.get(k):d;},set(k,v){storage.set(k,v);}},
Select:{show(x){menus.push(x);},close(){}},Player:{play(){}},Noty:{show(){}},Controller:{toggle(){}},
Reguest:function(){this.timeout=()=>{};this.silent=(url,ok,bad)=>{
 calls.push(url);if(simulateFailure)return bad({status:503},'network down');if(url.includes('archive.org/advancedsearch.php'))return ok({response:{docs:[{identifier:'sintel-test',title:'Sintel',year:'2010'}]}});
 if(url.includes('rutube.ru/api/search/video/'))return ok({results:[]});
 return bad({status:503},'error');
};}};
const window={Lampa:L,appready:true};
vm.runInNewContext(src,{window,Lampa:L,Promise,Date,URL,console,setTimeout,clearTimeout});
const movie={id:123,title:'Sintel',year:2010,release_date:'2010-01-01'};
const wait=async()=>{for(let i=0;i<40;i++)await new Promise(ok=>setImmediate(ok));};
(async()=>{
 assert.equal(plugin.version,'0.6.2');
 plugin.onContextLauch(movie);await wait();
 const kb=window.LampaVideoFinder.knowledgeStatus();
 assert.equal(kb.enabled,true);assert(kb.events>=2);
 assert(kb.sources.some(x=>x.id==='archive'&&x.profile.state!=='unknown'));
 assert(window.LampaVideoFinder.knownRoutes(movie).some(x=>x.page==='https://archive.org/details/sintel-test'));
 assert(storage.has('video_finder_cache_v3'));
 assert(storage.has('video_finder_kb_schema'));
 assert(menus.at(-1).items.some(x=>x._provider?.id==='archive'));
 assert(kb.bytes<=65536,'KB journal stays within byte budget');
 const saved=window.LampaVideoFinder.knownRoutes(movie);
 const eventsBefore=kb.events;
 simulateFailure=true;
 plugin.onContextLauch({id:456,title:'Another Movie',year:2024});await wait();
 const after=window.LampaVideoFinder.knowledgeStatus();
 assert(after.events>eventsBefore,'Network failure is recorded, not confused with EMPTY');
 const journal=JSON.parse(storage.get('video_finder_kb_observations_v1'));
 assert(journal.events.some(x=>x.class!=='FOUND'&&x.class!=='EMPTY'),
   'Network failure must not be classified as a successful empty answer');
 assert.equal(window.LampaVideoFinder.knownRoutes(movie).length,saved.length,
   'Network errors must preserve previously learned routes');
 console.log('PASS: KB captures outcomes, computes profiles, remembers stable routes and preserves cache');
})().catch(e=>{console.error(e);process.exitCode=1;});
