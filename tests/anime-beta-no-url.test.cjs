'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('PluginLampa-anime-beta.js','utf8');
const events={urls:[],menus:[],manifests:[],inputCallback:null};
const saved=[
  {url:'https://addon-a.test/manifest.json',manifest:{id:'test.direct',name:'Direct',types:['movie'],resources:['stream'],idPrefixes:['tt']}},
  {url:'https://addon-b.test/manifest.json',manifest:{id:'test.torrent',name:'TorrentsOnly',types:['movie'],resources:['stream'],idPrefixes:['tt']}}
];
const store=new Map([['video_finder_stremio_addons_v1',JSON.stringify(saved)]]);
const Lampa={
  Manifest:{set plugins(v){events.manifests.push(v);}},
  Storage:{get(k,d){return store.has(k)?store.get(k):d;},set(k,v){store.set(k,v);}},
  Reguest:function(){
    this.timeout=function(){};
    this.silent=function(url,success,fail){
      events.urls.push(url);
      if(url.includes('archive.org')) return success({response:{docs:[]}});
      if(url.includes('/api/search/video/')) return success({results:[{
        id:'rutube-film',title:'Sintel 2010',duration:5000,category:{id:4}
      }]});
      if(url==='https://addon-c.test/manifest.json')return success({id:'test.new',name:'NewDirect',types:['movie'],resources:['stream'],idPrefixes:['tt']});
      if(url.includes('addon-a.test/stream/movie/'))return success({streams:[{name:'Direct video',url:'https://media.test/one.mp4'}]});
      if(url.includes('addon-b.test/stream/movie/'))return success({streams:[{name:'Torrent only',infoHash:'a'.repeat(40),sources:['tracker:test']}]});
      if(url.includes('addon-c.test/stream/movie/'))return success({streams:[{name:'New direct',url:'https://media.test/two.mp4'}]});
      return fail({status:404},'not found');
    };
  },
  Noty:{show(){}},Select:{show(menu){events.menus.push(menu);},close(){}},
  Player:{play(){}},Controller:{toggle(){}},Listener:{follow(){}},
  Input:{edit(config,callback){events.inputCallback=callback;}}
};
const window={Lampa,appready:true};
vm.runInNewContext(source,{window,Lampa,Promise,Date,Math,JSON,URL:undefined,setTimeout,clearTimeout,console});
assert.deepEqual(Array.from(window.LampaVideoFinder.listProviders()).filter(x=>x!=='aniliberty').sort().slice(0,2),['archive','rutube']);
assert.equal(window.LampaVideoFinderStremio.list().length,2);
assert.equal(events.manifests.length,1);
const manager=window.LampaVideoFinderStremio;
assert.throws(()=>manager.install('http://unsafe.test/manifest.json'),/HTTPS/);
assert.throws(()=>manager.install('https://user:secret@bad.test/manifest.json'),/HTTPS/);
assert.throws(()=>manager.install('https://bad.test/manifest.json?token=SECRET'),/manifest.json/);
manager.manage();
const firstMenu=events.menus.at(-1);
firstMenu.onSelect(firstMenu.items.find(x=>x.action==='add'));
assert.equal(typeof events.inputCallback,'function');
events.inputCallback('');
assert(events.menus.at(-1).title.includes('Stremio · расширения'),
  'Cancel must restore Stremio manager on Tizen');

const card={id:42,title:'Sintel',original_title:'Sintel',year:2010,imdb_id:'tt15298954'};
const sleep=async()=>{for(let i=0;i<50;i++)await new Promise(resolve=>setImmediate(resolve));};
(async()=>{
  events.manifests[0].onContextLauch(card);
  await sleep();
  assert(events.urls.some(u=>u.includes('rutube.ru/api/search/video/')),'Rutube must run without title-only mode');
  assert(events.urls.some(u=>u.includes('addon-a.test/stream/movie/')),'Direct Stremio queried');
  assert(events.urls.some(u=>u.includes('addon-b.test/stream/movie/')),'Torrent-only Stremio queried');
  let menu=events.menus.at(-1);
  assert(menu.items.some(i=>i._provider?.id==='rutube'),'Rutube result visible');
  assert(menu.items.some(i=>i._provider?.name==='Stremio · Direct'),'Direct Stremio result visible');
  let diagnostic=menu.items.find(i=>i._action==='diagnostics');
  assert(diagnostic);
  menu.onSelect(diagnostic);
  assert(events.menus.at(-1).items.some(i=>/торрент/.test(i.subtitle||'')),'Torrent-only reason visible');
  assert(window.LampaVideoFinder.cacheStats().movies>0,'Results cached');
  const oldRutubeCalls=events.urls.filter(u=>u.includes('rutube.ru/api/search/video/')).length;
  await window.LampaVideoFinderStremio.install('https://addon-c.test');
  assert(window.LampaVideoFinder.cacheStats().movies>0,'Adding addon must not wipe cache');
  events.manifests[0].onContextLauch(card);
  await sleep();
  assert.equal(events.urls.filter(u=>u.includes('rutube.ru/api/search/video/')).length,oldRutubeCalls,'Cached Rutube not requeried');
  assert(events.urls.some(u=>u.includes('addon-c.test/stream/movie/')),'New Stremio is queried despite other cached results');
  menu=events.menus.at(-1);
  assert(menu.items.some(i=>i._provider?.name==='Stremio · NewDirect'),'New addon result visible');
  console.log('PASS: Tizen without URL constructor: Stremio addons, playback search, safe input cancellation and cache');
})().catch(e=>{console.error(e);process.exitCode=1;});
