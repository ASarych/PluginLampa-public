'use strict';
// Offline smoke test for the *published* Samsung Tizen build.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const script = fs.readFileSync('PluginLampa-tizen.js', 'utf8');
assert.match(script, /Lampa\.Manifest\.plugins/, "Lampa plugin checker expects Lampa.");
assert.doesNotMatch(script, /LampaVideoFinderStremio/);
const events = { menus: [], played: [], notices: [], registrations: [], urls: [] };
const storage = new Map();
const Lampa = {
  Manifest: { set plugins(item) { events.registrations.push(item); } },
  Storage: { get(k, d) { return storage.has(k) ? storage.get(k) : d; }, set(k, v) { storage.set(k, v); } },
  Reguest: function() {
    this.timeout = function() {};
    this.silent = function(url, success, error) {
      events.urls.push(url);
      if (url.includes('archive.org')) {
        success({response: {docs: []}});
      } else if (url.includes('/api/search/video/')) {
        success({results: [
          {id: 'test123', title: 'Sintel 2010', duration: 5500, category: {id: 4}},
          {id: 'preview', title: 'Sintel trailer', duration: 50, category: {id: 4}}
        ]});
      } else if (url.includes('/api/play/options/test123')) {
        success({video_balancer: {m3u8: 'https://example.org/play.m3u8'}});
      } else error({status: 404});
    };
  },
  Noty: {show(text) {events.notices.push(text);}},
  Select: {show(menu) {events.menus.push(menu);},close(){}},
  Player: {play(v) {events.played.push(v);}},
  Controller: {toggle(){}},
  Listener: {follow() {throw Error('Unexpected Listener registration');}}
};
const window = { Lampa, appready: true };
const sandbox = { window, Lampa, Promise, Date, setTimeout, clearTimeout, console, URL: undefined };
vm.runInNewContext(script, sandbox, {filename:'PluginLampa-tizen.js'});
assert.equal(events.registrations.length, 1);
assert.equal(events.registrations[0].version, '0.5.2');
assert.deepEqual(Array.from(window.LampaVideoFinder.listProviders()), ['archive','rutube']);
async function settle(){for(let n=0;n<25;n++) await new Promise(r=>setImmediate(r));}
(async()=>{
  events.registrations[0].onContextLauch({id:1,title:'Sintel',original_title:'Sintel',year:2010});
  await settle();
  assert(events.menus.length>0, 'Results menu opens');
  const result=events.menus.at(-1).items.find(x=>x._provider && x._provider.id==='rutube');
  assert(result, 'Rutube result available');
  events.menus.at(-1).onSelect(result);
  await settle();
  assert(events.menus.at(-1).items.some(x=>x.url && x.url.endsWith('.m3u8')));
  events.menus.at(-1).onSelect(events.menus.at(-1).items[0]);
  assert.equal(events.played[0].url, 'https://example.org/play.m3u8');
  console.log('PASS: Tizen no-URL boot, manifest registration, Archive + Rutube search, HLS URL');
})().catch(e=>{ console.error(e); process.exitCode=1; });
