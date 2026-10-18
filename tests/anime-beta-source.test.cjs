'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const js = fs.readFileSync(__dirname + '/../PluginLampa-anime-beta.js', 'utf8');
const state = new Map(), menus = [], played = [], urls = [], notices = [];
const release = { id: 9324, year: 2024, name: {main:'Аниме тест', english:'Anime Test'} };
let plugin;
const Lampa = {
  Manifest: {set plugins(x){plugin=x;}},
  Listener: {follow(){}},
  Storage: {get(k,d){return state.has(k)?state.get(k):d;},set(k,v){state.set(k,v);}},
  Noty: {show(text){notices.push(text);}},
  Select: {show(m){menus.push(m);},close(){}},
  Controller: {toggle(){}},
  Player: {play(v){played.push(v);}},
  Reguest: function () {
    this.timeout=function(){};
    this.silent=function(url,yes,no){
      urls.push(url);
      if(url.includes('archive.org/advancedsearch.php'))return yes({response:{docs:[]}});
      if(url.includes('rutube.ru/api/search/video/'))return yes({results:[]});
      if(url.includes('/api/v1/app/search/releases?query=')){
        const decoded=decodeURIComponent(url.split('query=')[1]||'');
        if(decoded==='Anime Test'||decoded==='Аниме тест')return yes([
          release,
          {id:111,year:2024,name:{main:'Другой сериал',english:'Other Show'}},
          {id:112,year:2021,name:{main:'Аниме тест',english:'Anime Test'}}
        ]);
        return yes([]);
      }
      if(url.includes('/api/v1/anime/releases/9324'))return yes({
        id:9324, episodes:[
          {ordinal:'1',name:'Пилот',hls_1080:'https://cdn.test/anime-1-1080.m3u8?token=temporary',
           hls_720:'http://insecure.test/720.m3u8',hls_480:'https://cdn.test/anime-1-480.m3u8'},
          {ordinal:'2',name:'Продолжение',hls_1080:'javascript:alert(1)',hls_720:'https://cdn.test/anime-2-720.m3u8'}
        ]
      });
      return no({status:503},'unexpected mock URL');
    };
  }
};
const window = {Lampa,appready:true};
vm.runInNewContext(js,{window,Lampa,Promise,Date,Math,JSON,URL:undefined,setTimeout,clearTimeout,console});
assert.equal(plugin.version,'0.6.3');
assert.deepEqual(Array.from(window.LampaVideoFinder.listProviders()).sort(),['aniliberty','archive','rutube']);
const movie={id:444,title:'Аниме тест',original_title:'Anime Test',year:2024,media_type:'tv'};
const wait=async()=>{for(let n=0;n<60;n++)await new Promise(r=>setImmediate(r));};
const searchHits=()=>urls.filter(x=>x.includes('/api/v1/app/search/releases?query=')).length;
(async()=>{
  plugin.onContextLauch(movie);
  await wait();
  assert.equal(searchHits(),0,'Disabled-by-default adapter cannot contact AniLiberty');
  let menu=menus.at(-1);
  assert(!menu.items.some(x=>x._provider?.id==='aniliberty'),'Disabled source has no results');
  assert(menu.items.some(x=>x._actionHandler?.id==='aniliberty-toggle'),'Toggle is accessible');
  menu.onSelect(menu.items.find(x=>x._actionHandler?.id==='aniliberty-toggle'));
  assert.equal(state.get('video_finder_aniliberty_enabled_v1'),true);
  menu.onSelect(menu.items.find(x=>x._action==='refresh'));
  await wait();
  assert.equal(searchHits(),2,'Queries RU and English names after explicit opt-in');
  menu=menus.at(-1);
  const items=menu.items.filter(x=>x._provider?.id==='aniliberty');
  assert.equal(items.length,1,'Only matching, same-year anime release listed');
  const diag=menu.items.find(x=>x._action==='diagnostics');
  assert(diag,'Standard source diagnostics remain available');
  menu.onSelect(items[0]);
  await wait();
  const streams=menus.at(-1);
  assert.equal(streams.items.length,3,'Only HTTPS HLS quality variants included');
  assert(streams.items[0].title.includes('Серия 1'));
  assert(!streams.items.some(x=>x.url.startsWith('http://')),'HTTP links excluded');
  streams.onSelect(streams.items[0]);
  assert.equal(played[0].url,'https://cdn.test/anime-1-1080.m3u8?token=temporary');
  for(const v of state.values())assert(!String(v).includes('temporary'),'Never persist signed playback URL');
  plugin.onContextLauch(movie);
  await wait();
  menu=menus.at(-1);
  assert(menu.items.some(x=>x._provider?.id==='aniliberty'),'Results cached while enabled');
  menu.onSelect(menu.items.find(x=>x._actionHandler?.id==='aniliberty-toggle'));
  assert.equal(state.get('video_finder_aniliberty_enabled_v1'),false);
  menu.onSelect(menu.items.find(x=>x._action==='refresh'));
  await wait();
  assert(!menus.at(-1).items.some(x=>x._provider?.id==='aniliberty'),'Source disappears after disabling');
  plugin.onContextLauch(movie);
  await wait();
  assert(!menus.at(-1).items.some(x=>x._provider?.id==='aniliberty'),'Cached results do not override disabled source');
  const requestsAtEnd=searchHits();
  assert.equal(requestsAtEnd,2);
  console.log('PASS AniLiberty: opt-in, dual title search, safe matches, episodes, HTTPS-only, signed URL cache, disabled-cache isolation, Tizen without URL');
})().catch(e=>{console.error(e);process.exitCode=1;});
