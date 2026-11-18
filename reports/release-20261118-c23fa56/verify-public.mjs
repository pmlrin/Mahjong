import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const origin='https://mahjong.yangjm.cn',dir='reports/release-20261118-c23fa56';
const get=async p=>{const r=await fetch(origin+p);assert.equal(r.status,200,p);return r};
const health=await (await get('/healthz')).json();
assert.equal(health.buildId,'cecc4698047f7e50aa2c29c2ea08ae7722f6309c7a4ec6eca3844cbe063c8959');
const capabilities=(await (await get('/api/v2/capabilities')).json()).data;
assert.equal(capabilities.maintenance,false);
assert.deepEqual(capabilities.botLevels,['BASIC','STANDARD','ADVANCED','MASTER']);
assert.equal(capabilities.autopilotBotLevel,'STANDARD');
const identity=JSON.parse(fs.readFileSync('/tmp/mahjong-predeploy-identity-9acbe5a.json'));
const me=await fetch(origin+'/api/v2/me',{headers:{Cookie:identity.cookie}});
assert.equal(me.status,200);assert.equal((await me.json()).data.userId,identity.userId);
const files=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else files.push(p)}}
walk('dist');
const assets=[];
for(let i=0;i<files.length;i+=5){await Promise.all(files.slice(i,i+5).map(async file=>{
const url='/'+path.relative('dist',file).split(path.sep).join('/');
const content=Buffer.from(await (await get(url)).arrayBuffer());
assert.deepEqual(content,fs.readFileSync(file),url);
assets.push({url,bytes:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex')});
}))}
const preview=await (await get('/preview/healthz')).json();
assert.equal(preview.version,'0.4.1');
const report={at:new Date().toISOString(),origin,health,maintenance:capabilities.maintenance,botLevels:capabilities.botLevels,autopilotBotLevel:capabilities.autopilotBotLevel,existingGuestSessionPreserved:true,preview,assets,passed:true};
fs.writeFileSync(dir+'/production-public.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,health,existingGuestSessionPreserved:true,verifiedFiles:assets.length,previewVersion:preview.version}));
