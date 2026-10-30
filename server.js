const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const LIMIT = 12000;
function fresh() { return { packs: [], blocks: new Map(), logs: [], functions: new Map(), scoreboards: new Map(), entities: [], runCount: 0 }; }
function log(s, level, message) { s.logs.push({ time: new Date().toISOString(), level, message }); if (s.logs.length > 500) s.logs.shift(); }
function parseMcfunction(text) { return text.split(/\r?\n/).map((line, i) => ({ line: i + 1, command: line.trim() })).filter(x => x.command && !x.command.startsWith('#')); }
function blockKey(x,y,z) { return x + ',' + y + ',' + z; }
function parsePos(raw, origin) {
  const parts = raw.split(',');
  if (parts.length !== 3) throw new Error('Expected three coordinates');
  return parts.map((v,i) => v.startsWith('~') ? origin[i] + (v.length > 1 ? Number(v.slice(1)) : 0) : Number(v));
}
function runFunction(s, name, origin=[0,64,0], stack=[]) {
  if (stack.length > 32) { log(s,'error','Function recursion limit reached'); return; }
  if (s.runCount > LIMIT) { log(s,'error','Command limit reached; stopped safely'); return; }
  const commands = s.functions.get(name);
  if (!commands) { log(s,'error','Function not found: ' + name); return; }
  stack = [...stack, name];
  for (const item of commands) {
    if (++s.runCount > LIMIT) break;
    const c = item.command;
    try {
      if (c.startsWith('say ')) log(s,'info',c.slice(4));
      else if (c.startsWith('tellraw ')) log(s,'info','tellraw: ' + c.slice(8));
      else if (c.startsWith('setblock ')) {
        const m = c.match(/^setblock\s+(\S+)\s+(\S+)(?:\s+(\S+))?/);
        if (!m) throw new Error('Invalid setblock syntax');
        const p = parsePos(m[1],origin); s.blocks.set(blockKey(...p),m[2]); log(s,'success','Placed ' + m[2] + ' at ' + p.join(' '));
      } else if (c.startsWith('fill ')) {
        const m = c.match(/^fill\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?/);
        if (!m) throw new Error('Invalid fill syntax');
        const a=parsePos(m[1],origin), b=parsePos(m[2],origin), block=m[3];
        const lo=a.map((v,i)=>Math.min(v,b[i])), hi=a.map((v,i)=>Math.max(v,b[i]));
        const volume=(hi[0]-lo[0]+1)*(hi[1]-lo[1]+1)*(hi[2]-lo[2]+1);
        if (volume>50000) throw new Error('Fill exceeds 50,000 block safety limit');
        for(let x=lo[0];x<=hi[0];x++) for(let y=lo[1];y<=hi[1];y++) for(let z=lo[2];z<=hi[2];z++) s.blocks.set(blockKey(x,y,z),block);
        log(s,'success','Filled ' + volume + ' blocks with ' + block);
      } else if (c.startsWith('function ')) runFunction(s,c.slice(9).trim(),origin,stack);
      else if (c.startsWith('setworldspawn')) log(s,'info','setworldspawn recognized (spawn metadata not yet simulated)');
      else if (c.startsWith('gamerule ')) log(s,'info','gamerule recognized (rule state not yet simulated)');
      else if (c.startsWith('summon ')) {
        const m=c.match(/^summon\s+(\S+)(?:\s+(\S+)\s+(\S+)\s+(\S+))?/);
        if(!m) throw new Error('Invalid summon syntax');
        const p=m[2]?[Number(m[2]),Number(m[3]),Number(m[4])]:origin;
        s.entities.push({type:m[1],x:p[0],y:p[1],z:p[2]}); log(s,'success','Summoned ' + m[1]);
      } else if (c.startsWith('execute ')) log(s,'warning','execute is not implemented yet: ' + c);
      else if (c.startsWith('scoreboard ')) log(s,'warning','scoreboard is not implemented yet: ' + c);
      else log(s,'warning','Unsupported command at line ' + item.line + ': ' + c);
    } catch(e) { log(s,'error','Line ' + item.line + ': ' + e.message); }
  }
}
async function loadZip(buffer,s) {
  const zip=await JSZip.loadAsync(buffer);
  let meta=false, found=0;
  for(const [file,entry] of Object.entries(zip.files)) {
    if(entry.dir) continue;
    if(file.endsWith('/pack.mcmeta') || file==='pack.mcmeta') meta=true;
    const match=file.match(/^data\/([^/]+)\/functions?\/(.+)\.mcfunction$/);
    if(match) {
      const body=await entry.async('string');
      const name=match[1]+':'+match[2].replaceAll('/','/');
      s.functions.set(name,parseMcfunction(body)); found++;
    }
  }
  if(!meta) throw new Error('pack.mcmeta was not found. Upload a valid datapack ZIP.');
  if(!found) log(s,'warning','No .mcfunction files found in the ZIP.');
  s.packs.push({name:'Uploaded datapack',functions:found});
  log(s,'success','Loaded datapack: ' + found + ' function(s)');
  for(const [file,entry] of Object.entries(zip.files)) {
    if(entry.dir) continue;
    const m=file.match(/^data\/([^/]+)\/tags\/functions\/(load|tick)\.json$/);
    if(m) {
      try {
        const json=JSON.parse(await entry.async('string'));
        for(const f of json.values||[]) if(typeof f==='string') {
          if(m[2]==='load') runFunction(s,f);
          if(m[2]==='tick') log(s,'info','Tick function registered: '+f+' (run manually in this preview)');
        }
      } catch(e) { log(s,'error','Invalid function tag JSON: '+e.message); }
    }
  }
}
function state(s) { return { packs:s.packs, blocks:[...s.blocks.entries()].map(([key,block])=>({pos:key.split(',').map(Number),block})), entities:s.entities, logs:s.logs, functions:[...s.functions.keys()], runCount:s.runCount }; }

app.get('/api/health',(req,res)=>res.json({ok:true,name:'Minecraft Datapack Lab',engine:'browser-preview-subset',mcp:'/mcp'}));
app.post('/api/reset',(req,res)=>{ const id=req.body.sessionId||'default'; sessions.set(id,fresh()); res.json({ok:true,sessionId:id}); });
app.post('/api/upload',upload.single('datapack'),async(req,res)=>{
  try { if(!req.file) return res.status(400).json({error:'Choose a datapack .zip first'}); const id=req.body.sessionId||'default'; const s=fresh(); await loadZip(req.file.buffer,s); sessions.set(id,s); res.json({ok:true,sessionId:id,state:state(s)}); }
  catch(e){ res.status(400).json({error:e.message}); }
});
app.post('/api/run',(req,res)=>{
  const id=req.body.sessionId||'default', s=sessions.get(id); if(!s) return res.status(404).json({error:'Upload a datapack first'});
  const name=req.body.function; if(!name) return res.status(400).json({error:'Function name required'});
  s.runCount=0; runFunction(s,name,Array.isArray(req.body.origin)?req.body.origin:[0,64,0]); res.json({ok:true,state:state(s)});
});
app.get('/api/state',(req,res)=>{ const s=sessions.get(req.query.sessionId||'default'); if(!s) return res.json({packs:[],blocks:[],entities:[],logs:[],functions:[],runCount:0}); res.json(state(s)); });

// Minimal MCP Streamable HTTP JSON-RPC endpoint. Tools are intentionally limited to this sandbox.
app.post('/mcp',async(req,res)=>{
  const msg=req.body||{}, id=msg.id??null, method=msg.method;
  const reply=(result)=>res.json({jsonrpc:'2.0',id,result});
  const error=(code,message)=>res.status(200).json({jsonrpc:'2.0',id,error:{code,message}});
  if(method==='initialize') return reply({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'minecraft-datapack-lab',version:'1.0.0'}});
  if(method==='notifications/initialized') return res.status(202).end();
  if(method==='ping') return reply({});
  if(method==='tools/list') return reply({tools:[
    {name:'get_sandbox_state',description:'Get current preview world, loaded functions and execution logs.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}},additionalProperties:false}},
    {name:'run_function',description:'Run a loaded datapack function by namespaced ID, such as example:build.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},function:{type:'string'},origin:{type:'array',items:{type:'number'},minItems:3,maxItems:3}},required:['function'],additionalProperties:false}},
    {name:'reset_world',description:'Clear the preview world and logs.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}},additionalProperties:false}}
  ]});
  if(method==='tools/call') {
    const t=msg.params?.name, a=msg.params?.arguments||{}, sid=a.sessionId||'default'; let s=sessions.get(sid);
    if(t==='get_sandbox_state') return reply({content:[{type:'text',text:JSON.stringify(state(s||fresh()))}]});
    if(t==='reset_world'){sessions.set(sid,fresh());return reply({content:[{type:'text',text:'Preview world reset.'} ]});}
    if(t==='run_function'){if(!s)return error(-32004,'No datapack loaded for this session. Upload it through the website first.'); s.runCount=0; runFunction(s,a.function,Array.isArray(a.origin)?a.origin:[0,64,0]); return reply({content:[{type:'text',text:JSON.stringify(state(s))}]});}
    return error(-32602,'Unknown tool: '+t);
  }
  return error(-32601,'Method not found');
});
app.get('/mcp',(req,res)=>res.json({name:'Minecraft Datapack Lab MCP',endpoint:'/mcp',transport:'HTTP JSON-RPC',method:'POST'}));
const port=process.env.PORT||3000;
app.listen(port,'0.0.0.0',()=>console.log('Minecraft Datapack Lab listening on '+port));
