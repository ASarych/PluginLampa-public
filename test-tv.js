'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/tv.js','utf8');
new vm.Script(source,{filename:'tv.js'});
const begin=source.indexOf('  var PROGRESS_KEY=');
const end=source.indexOf('  function chooseStream(',begin);
assert(begin>0&&end>begin,'playback progress module is included');
const moduleSource=source.slice(begin,end);
function initialize(storage,playerVideo){
  const window={};
  const L={Storage:{
    get(k,fallback){return storage.has(k)?storage.get(k):fallback;},
    set(k,v){storage.set(k,v);}
  },PlayerVideo:playerVideo};
  const timers=new Map();let next=0;
  const build=new Function('L','window','setInterval','clearInterval',
    moduleSource+'\nreturn {api:window.PluginLampaProgress,write:progressWrite,watch:progressWatch};');
  const result=build(L,window,(fn)=>{timers.set(++next,fn);return next;},id=>timers.delete(id));
  result.pump=()=>Array.from(timers.values()).forEach(fn=>fn());
  return result;
}
const store=new Map();
const movie={tmdb_id:272,media_type:'movie',card:{}};
const ep2={tmdb_id:1396,media_type:'tv',card:{season_number:2,episode_number:2}};
const ep3={tmdb_id:1396,media_type:'tv',card:{season_number:2,episode_number:3}};
const first=initialize(store);
assert.equal(first.api.progressId(movie),'movie:272');
assert.equal(first.api.progressId(ep2),'tv:1396:2:2');
assert.equal(first.api.progressId(ep3),'tv:1396:2:3');
assert.equal(first.api.progressId({tmdb_id:'invalid',media_type:'movie',card:{}}),'');
first.write(first.api.progressId(ep2),1122,2400,false);
first.write(first.api.progressId(ep3),2400,2400,true);
assert.equal(first.api.get(ep2).position,1122);
assert.equal(first.api.get(ep2).watched,false);
assert.equal(first.api.get(ep3).watched,true);
assert.equal(first.api.get(movie),null);
first.api.setSettings({resume:false,watchedPercent:95});
const afterRestart=initialize(store);
assert.equal(afterRestart.api.get(ep2).position,1122,'resume survives plugin restart');
assert.equal(afterRestart.api.settings().resume,false);
assert.equal(afterRestart.api.settings().watchedPercent,95);
assert.equal(typeof afterRestart.api.mark,'function');
assert.equal(afterRestart.api.mark(ep2,true),true);
assert.equal(afterRestart.api.get(ep2).watched,true);
assert.equal(afterRestart.api.mark(ep2,false),true);
assert.equal(afterRestart.api.get(ep2),null);
first.write(first.api.progressId(ep2),1122,2400,false);

assert(!JSON.stringify(Array.from(store.values())).includes('https://'),'no media URL persisted');
assert(!source.includes('Подключить Онлайн Мод'),'removed online-mod installer stays removed');
assert(!source.includes('Rezka ·'),'removed Rezka route stays removed');
assert(source.includes("L.Storage.get(KEY,false)"),'Atodo stays opt-in');
assert(source.includes('getEpisodeAvailability:'),'source catalogue availability API wired');
assert(source.includes('highestQualityStream(streams)'), 'automatic playback uses maximum quality');
assert(!source.includes("pluginlampa_preferred_quality_v1"), 'manual quality preference removed');
assert(source.includes("this.playNextEpisode = function(card)"),'native next-episode handler installed');
assert(source.includes("el.addEventListener('ended',ended)"),'next episode follows real ended event');

assert(source.includes('refreshEpisodeMetadata'),'Russian episode updates refresh native rows');
assert(source.includes('consumeEpisodeAutoStream'),'single episode selection consumes auto playback intent');
assert(source.includes('availableEpisodes:function(m)'), 'Atodo catalogue adapter present');
function video(){
  const callbacks=new Map();
  return {readyState:0, currentTime:0,duration:1800,ended:false,
    addEventListener(k,fn){const arr=callbacks.get(k)||[];arr.push(fn);callbacks.set(k,arr);},
    removeEventListener(k,fn){callbacks.set(k,(callbacks.get(k)||[]).filter(x=>x!==fn));},
    fire(k){(callbacks.get(k)||[]).forEach(fn=>fn());}};
}
const media=video();const active=initialize(store,{video:()=>media});
active.api.setSettings({resume:true,watchedPercent:90});
active.watch(ep2);media.fire('loadedmetadata');
assert.equal(media.currentTime,1122,'restores saved position on actual metadata event');
media.currentTime=1250;media.fire('pause');
assert.equal(active.api.get(ep2).position,1250);
media.currentTime=1660;media.fire('ended');
assert.equal(active.api.get(ep2).watched,true);
console.log('PASS: tv.js syntax, stable identities, restart resume, media events, settings, watched toggle, no signed URL persistence, opt-in providers');
