import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const origin='https://mahjong.yangjm.cn',dir='reports/release-20261119-146cbbe';
const get=async p=>{const r=await fetch(origin+p);assert.equal(r.status,200,p);return r};
const health=await (await get('/healthz')).json();
assert.equal(health.buildId,'95babb720f0d45cfab1ffd220cff725c16f178103f6eedeceaa8f9e0a782fdec');
const capabilities=(await (await get('/api/v2/capabilities')).json()).data;
assert.equal(capabilities.maintenance,false);
assert.deepEqual(capabilities.botLevels,['BASIC','STANDARD','ADVANCED','MASTER']);
assert.equal(capabilities.autopilotBotLevel,'STANDARD');
const identity=JSON.parse(fs.readFileSync('/tmp/mahjong-predeploy-identity-146cbbe.json'));
const me=await fetch(origin+'/api/v2/me',{headers:{Cookie:identity.cookie}});
assert.equal(me.status,200);assert.equal((await me.json()).data.userId,identity.userId);
const files=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else files.push(p)}}
const dist='/tmp/mahjong-146cbbe.So1z8C/dist';
walk(dist);
const assets=[];
for(let i=0;i<files.length;i+=5){await Promise.all(files.slice(i,i+5).map(async file=>{
const url='/'+path.relative(dist,file).split(path.sep).join('/');
const content=Buffer.from(await (await get(url)).arrayBuffer());
assert.deepEqual(content,fs.readFileSync(file),url);
assets.push({url,bytes:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex')});
}))}
assert.match(fs.readFileSync(dist+'/index.html','utf8'),/<title>明烛｜雪夜四人立直麻将<\/title>/);
const authed = {headers:{Cookie:identity.cookie}};
const lobbyReply = await fetch(origin+'/api/v2/rooms/public',authed);
assert.equal(lobbyReply.status,200);
const lobby = (await lobbyReply.json()).data;
assert(Array.isArray(lobby.rooms) && Number.isInteger(lobby.online));
for (const room of lobby.rooms) {
 assert(!Object.hasOwn(room,'inviteCode') && Array.isArray(room.seats));
 assert(room.seats.every(seat=>!seat || !Object.hasOwn(seat,'userId')));
}
const queueReply = await fetch(origin+'/api/v2/match/queue',authed);
assert.equal(queueReply.status,200);
assert.equal((await queueReply.json()).data.queued,false);
const lobbyAnonymous = await fetch(origin+'/api/v2/rooms/public');
assert.equal(lobbyAnonymous.status,401);
const preview=await (await get('/preview/healthz')).json();
assert.equal(preview.version,'0.4.1');
const report={at:new Date().toISOString(),origin,health,maintenance:capabilities.maintenance,botLevels:capabilities.botLevels,autopilotBotLevel:capabilities.autopilotBotLevel,existingGuestSessionPreserved:true,lobbyReadOnlyVerified:true,preview,assets,passed:true};
fs.writeFileSync(dir+'/production-public.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,health,existingGuestSessionPreserved:true,verifiedFiles:assets.length,previewVersion:preview.version}));
