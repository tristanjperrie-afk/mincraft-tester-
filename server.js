'use strict';
const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });
app.use(express.json({ limit: '48mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const LIMITS = { commands: 40000, blocks: 180000, fill: 50000, logs: 1500, recursion: 64 };
const now = () => new Date().toISOString();
const makeWorld = () => ({
  packs: [], functions: new Map(), loadFunctions: [], tickFunctions: [],
  blocks: new Map(), entities: [], objectives: new Map(), scores: new Map(),
  gamerules: {}, time: 0, weather: 'clear', difficulty: 'normal',
  worldspawn: [0, 64, 0], logs: [], runCount: 0, lastRun: null
});
const getSession = id => {
  const key = String(id || 'default').slice(0, 100);
  if (!sessions.has(key)) sessions.set(key, makeWorld());
  return sessions.get(key);
};
const log = (w, level, message) => {
  w.logs.push({ time: now(), level, message: String(message) });
  if (w.logs.length > LIMITS.logs) w.logs.splice(0, w.logs.length - LIMITS.logs);
};
const posKey = (p) => p.map(v => Math.floor(v)).join(',');
const parsePos = (tokens, origin) => {
  if (!Array.isArray(tokens) || tokens.length < 3) throw new Error('Expected three coordinates');
  return tokens.slice(0, 3).map((raw, i) => {
    const v = String(raw);
    if (v.startsWith('~')) return origin[i] + (v.length > 1 ? Number(v.slice(1)) : 0);
    if (v.startsWith('^')) throw new Error('Local ^ coordinates are not supported yet');
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('Invalid coordinate: ' + v);
    return n;
  });
};
function tokenize(input) {
  const out = []; let token = '', quote = null, square = 0, curly = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) { token += c; if (c === quote && input[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; token += c; continue; }
    if (c === '[') square++; if (c === ']') square--;
    if (c === '{') curly++; if (c === '}') curly--;
    if (/\s/.test(c) && square <= 0 && curly <= 0) { if (token) out.push(token); token = ''; }
    else token += c;
  }
  if (token) out.push(token);
  return out;
}
const unquote = s => String(s || '').replace(/^["']|["']$/g, '');
const scoreKey = (holder, objective) => holder + '|' + objective;
const getScore = (w, h, o) => w.scores.get(scoreKey(h, o)) ?? 0;
const setScore = (w, h, o, n) => {
  if (!Number.isFinite(Number(n))) throw new Error('Score must be a number');
  w.scores.set(scoreKey(h, o), Math.max(-2147483648, Math.min(2147483647, Math.trunc(Number(n)))));
};
function parseSelectorArgs(selector) {
  const match = selector.match(/^@[pares](?:\[(.*)\])?$/);
  if (!match) return null;
  const args = {};
  const raw = match[1] || '';
  let part = '', quote = null, depth = 0;
  const parts = [];
  for (const c of raw) {
    if (quote) { part += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; part += c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { if (part.trim()) parts.push(part.trim()); part = ''; }
    else part += c;
  }
  if (part.trim()) parts.push(part.trim());
  for (const p of parts) { const i = p.indexOf('='); if (i > 0) args[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return { type: selector[1], args };
}
function selectEntities(w, selector, ctx) {
  if (selector === '@s') return ctx.entity ? [ctx.entity] : [];
  const parsed = parseSelectorArgs(selector);
  if (!parsed) return [];
  let list = w.entities.slice();
  const a = parsed.args;
  if (a.type) {
    const wanted = a.type.replace(/^!/, '');
    list = list.filter(e => a.type.startsWith('!') ? e.type !== wanted : e.type === wanted);
  }
  if (a.tag) list = list.filter(e => (a.tag.startsWith('!') ? !(e.tags || []).includes(a.tag.slice(1)) : (e.tags || []).includes(a.tag)));
  if (a.name) list = list.filter(e => e.name === unquote(a.name));
  if (a.x !== undefined && a.y !== undefined && a.z !== undefined) {
    const x = Number(a.x), y = Number(a.y), z = Number(a.z);
    list = list.filter(e => Math.floor(e.x) === x && Math.floor(e.y) === y && Math.floor(e.z) === z);
  }
  if (a.distance) {
    const [min, max] = a.distance.split('..');
    const origin = ctx.pos || [0, 64, 0];
    list = list.filter(e => {
      const d = Math.hypot(e.x - origin[0], e.y - origin[1], e.z - origin[2]);
      return (min === '' || min === undefined || d >= Number(min)) && (max === undefined || max === '' || d <= Number(max));
    });
  }
  if (a.sort === 'nearest') list.sort((x, y) => Math.hypot(x.x-ctx.pos[0],x.y-ctx.pos[1],x.z-ctx.pos[2]) - Math.hypot(y.x-ctx.pos[0],y.y-ctx.pos[1],y.z-ctx.pos[2]));
  if (a.sort === 'furthest') list.sort((x, y) => Math.hypot(y.x-ctx.pos[0],y.y-ctx.pos[1],y.z-ctx.pos[2]) - Math.hypot(x.x-ctx.pos[0],x.y-ctx.pos[1],x.z-ctx.pos[2]));
  if (a.limit) list = list.slice(0, Math.max(0, Number(a.limit)));
  if (parsed.type === 'p' || parsed.type === 'r' || parsed.type === 'a') return [];
  return list;
}
function putBlock(w, p, block) {
  const k = posKey(p);
  if (w.blocks.size >= LIMITS.blocks && !w.blocks.has(k)) throw new Error('World block safety limit reached (' + LIMITS.blocks + ')');
  if (block === 'air' || block === 'minecraft:air' || block === 'cave_air' || block === 'minecraft:cave_air' || block === 'void_air' || block === 'minecraft:void_air') w.blocks.delete(k);
  else w.blocks.set(k, block);
}
function blockAt(w, p) { return w.blocks.get(posKey(p)) || 'minecraft:air'; }
function executeCondition(w, kind, tokens, index, ctx) {
  const origin = ctx.pos;
  if (kind === 'block') {
    const p = parsePos(tokens.slice(index, index + 3), origin);
    const expected = tokens[index + 3];
    return { ok: blockAt(w, p) === expected, next: index + 4 };
  }
  if (kind === 'entity') {
    const selector = tokens[index];
    return { ok: selectEntities(w, selector, ctx).length > 0, next: index + 1 };
  }
  if (kind === 'score') {
    const holder = tokens[index], objective = tokens[index + 1], op = tokens[index + 2];
    if (op === 'matches') {
      const range = tokens[index + 3] || '';
      const value = getScore(w, holder, objective);
      const parts = range.split('..');
      const ok = parts.length === 1 ? value === Number(parts[0]) :
        (parts[0] === '' || value >= Number(parts[0])) && (parts[1] === '' || value <= Number(parts[1]));
      return { ok, next: index + 4 };
    }
    const otherHolder = tokens[index + 3], otherObjective = tokens[index + 4];
    const x = getScore(w, holder, objective), y = getScore(w, otherHolder, otherObjective);
    const ops = { '=': x === y, '==': x === y, '>': x > y, '>=': x >= y, '<': x < y, '<=': x <= y };
    if (!(op in ops)) throw new Error('Unsupported score comparison: ' + op);
    return { ok: ops[op], next: index + 5 };
  }
  throw new Error('Unsupported execute condition: ' + kind);
}
function runFunction(w, id, ctx, stack = []) {
  const lines = w.functions.get(id);
  if (!lines) { log(w, 'error', 'Function not found: ' + id); return; }
  if (stack.length >= LIMITS.recursion) { log(w, 'error', 'Function recursion limit reached'); return; }
  for (const entry of lines) {
    if (++w.runCount > LIMITS.commands) { log(w, 'error', 'Execution command limit reached'); return; }
    try { runCommand(w, entry.command, ctx, stack.concat(id)); }
    catch (e) { log(w, 'error', id + ':' + entry.line + ' — ' + e.message); }
  }
}
function runCommand(w, line, ctx, stack) {
  const t = tokenize(line);
  if (!t.length) return;
  const cmd = t[0], origin = ctx.pos;
  if (cmd === 'execute') {
    let i = 1, contexts = [ctx];
    while (i < t.length && t[i] !== 'run') {
      const sub = t[i++];
      if (sub === 'as' || sub === 'at') {
        const selector = t[i++];
        contexts = contexts.flatMap(c => {
          const targets = selectEntities(w, selector, c);
          return targets.map(entity => sub === 'as' ? { ...c, entity } : { ...c, pos: [entity.x, entity.y, entity.z] });
        });
      } else if (sub === 'positioned') {
        if (t[i] === 'as') {
          i++; const targets = selectEntities(w, t[i++], contexts[0] || ctx);
          contexts = contexts.flatMap(c => targets.map(e => ({ ...c, pos: [e.x, e.y, e.z] })));
        } else {
          const p = parsePos(t.slice(i, i + 3), contexts[0]?.pos || origin); i += 3;
          contexts = contexts.map(c => ({ ...c, pos: p }));
        }
      } else if (sub === 'if' || sub === 'unless') {
        const condition = executeCondition(w, t[i++], t, i, contexts[0] || ctx);
        i = condition.next;
        contexts = contexts.filter(() => sub === 'if' ? condition.ok : !condition.ok);
      } else if (sub === 'align' || sub === 'anchored') {
        i++;
      } else if (sub === 'rotated') {
        i += 2;
      } else if (sub === 'facing') {
        i += (t[i] === 'entity' ? 3 : 3);
      } else if (sub === 'in') {
        i++;
      } else {
        throw new Error('Unsupported execute subcommand: ' + sub);
      }
    }
    if (t[i] !== 'run') throw new Error('Expected "run" in execute command');
    const nested = t.slice(i + 1).join(' ');
    for (const c of contexts) runCommand(w, nested, c, stack);
    return;
  }
  if (cmd === 'function') { runFunction(w, t[1], ctx, stack); return; }
  if (['say','me','tellraw','title','tell','msg','w'].includes(cmd)) { log(w, 'info', cmd + ': ' + t.slice(1).join(' ')); return; }
  if (cmd === 'setblock') {
    if (t.length < 5) throw new Error('Usage: setblock x y z block [destroy|keep|replace]');
    const p = parsePos(t.slice(1, 4), origin), block = t[4], mode = t[5] || 'replace';
    if (mode === 'keep' && blockAt(w, p) !== 'minecraft:air') return;
    putBlock(w, p, block); log(w, 'success', 'setblock ' + p.join(' ') + ' ' + block); return;
  }
  if (cmd === 'fill') {
    if (t.length < 8) throw new Error('Usage: fill x1 y1 z1 x2 y2 z2 block [mode]');
    const a = parsePos(t.slice(1,4),origin), b = parsePos(t.slice(4,7),origin), block = t[7], mode = t[8] || 'replace';
    const lo = a.map((v,i)=>Math.floor(Math.min(v,b[i]))), hi = a.map((v,i)=>Math.floor(Math.max(v,b[i])));
    const volume = (hi[0]-lo[0]+1)*(hi[1]-lo[1]+1)*(hi[2]-lo[2]+1);
    if (volume > LIMITS.fill) throw new Error('Fill volume ' + volume + ' exceeds safety limit ' + LIMITS.fill);
    let changed = 0;
    for (let x=lo[0];x<=hi[0];x++) for(let y=lo[1];y<=hi[1];y++) for(let z=lo[2];z<=hi[2];z++) {
      const edge = x===lo[0]||x===hi[0]||y===lo[1]||y===hi[1]||z===lo[2]||z===hi[2];
      const old = blockAt(w,[x,y,z]);
      if (mode==='keep' && old!=='minecraft:air') continue;
      if (mode==='outline' && !edge) continue;
      if (mode==='hollow' && !edge) putBlock(w,[x,y,z],'air');
      else if (mode==='replace' || mode==='destroy' || mode==='outline' || mode==='hollow' || mode==='keep') putBlock(w,[x,y,z],block);
      else if (mode==='replace' && t[9] && old!==t[9]) continue;
      else throw new Error('Unsupported fill mode: '+mode);
      changed++;
    }
    log(w,'success','fill affected '+changed+' blocks'); return;
  }
  if (cmd === 'clone') {
    if(t.length<10) throw new Error('Usage: clone x1 y1 z1 x2 y2 z2 destX destY destZ');
    const a=parsePos(t.slice(1,4),origin),b=parsePos(t.slice(4,7),origin),d=parsePos(t.slice(7,10),origin);
    const lo=a.map((v,i)=>Math.floor(Math.min(v,b[i]))),hi=a.map((v,i)=>Math.floor(Math.max(v,b[i])));
    const count=(hi[0]-lo[0]+1)*(hi[1]-lo[1]+1)*(hi[2]-lo[2]+1);
    if(count>LIMITS.fill) throw new Error('Clone volume exceeds safety limit');
    const copy=[];
    for(let x=lo[0];x<=hi[0];x++)for(let y=lo[1];y<=hi[1];y++)for(let z=lo[2];z<=hi[2];z++) copy.push([x-lo[0]+Math.floor(d[0]),y-lo[1]+Math.floor(d[1]),z-lo[2]+Math.floor(d[2]),blockAt(w,[x,y,z])]);
    for(const [x,y,z,bk] of copy) putBlock(w,[x,y,z],bk);
    log(w,'success','clone copied '+copy.length+' block positions'); return;
  }
  if (cmd === 'summon') {
    if(!t[1]) throw new Error('Usage: summon entity_type [x y z]');
    const p=t.length>=5?parsePos(t.slice(2,5),origin):origin;
    const e={id:'e'+crypto.randomUUID().slice(0,8),type:t[1],x:p[0],y:p[1],z:p[2],tags:[],name:null};
    w.entities.push(e); log(w,'success','summoned '+e.type+' at '+p.join(' ')); return;
  }
  if (cmd === 'kill') {
    const targets=t[1]==='@s'?(ctx.entity?[ctx.entity]:[]):selectEntities(w,t[1]||'@e',ctx);
    w.entities=w.entities.filter(e=>!targets.includes(e)); log(w,'success','removed '+targets.length+' simulated entities'); return;
  }
  if (cmd === 'tp' || cmd === 'teleport') {
    const selector=t[1], targets=selector==='@s'?(ctx.entity?[ctx.entity]:[]):selectEntities(w,selector,ctx);
    const p=parsePos(t.slice(2,5),origin);
    for(const e of targets){e.x=p[0];e.y=p[1];e.z=p[2]}
    if(!targets.length) log(w,'warning','No simulated entities matched teleport target'); return;
  }
  if (cmd === 'tag') {
    const targets=t[1]==='@s'?(ctx.entity?[ctx.entity]:[]):selectEntities(w,t[1],ctx);
    for(const e of targets){e.tags=e.tags||[];if(t[2]==='add'&&!e.tags.includes(t[3]))e.tags.push(t[3]);else if(t[2]==='remove')e.tags=e.tags.filter(x=>x!==t[3]);else if(t[2]==='list')log(w,'info',e.id+' tags: '+e.tags.join(', '))}
    return;
  }
  if (cmd === 'scoreboard') {
    if(t[1]==='objectives'){
      if(t[2]==='add'){if(w.objectives.has(t[3]))throw new Error('Objective already exists: '+t[3]);w.objectives.set(t[3],{criterion:t[4],display:t.slice(5).join(' ')});log(w,'success','objective added: '+t[3]);}
      else if(t[2]==='remove')w.objectives.delete(t[3]);
      else if(t[2]==='list')log(w,'info','Objectives: '+[...w.objectives.keys()].join(', '));
      else if(t[2]==='setdisplay')log(w,'info','Display slot recorded: '+t.slice(3).join(' '));
      return;
    }
    if(t[1]==='players'){
      const action=t[2],holder=t[3],objective=t[4];
      if(['set','add','remove'].includes(action)){const n=Number(t[5]);setScore(w,holder,objective,action==='set'?n:getScore(w,holder,objective)+(action==='add'?n:-n));log(w,'success',holder+' '+objective+' = '+getScore(w,holder,objective));}
      else if(action==='get')log(w,'info',holder+' '+objective+' = '+getScore(w,holder,objective));
      else if(action==='reset')w.scores.delete(scoreKey(holder,objective));
      else if(action==='list')log(w,'info','Scores: '+[...w.scores.entries()].map(([k,v])=>k+'='+v).join(', '));
      else if(action==='operation'){
        const op=t[5],other=getScore(w,t[6],t[7]),value=getScore(w,holder,objective);
        const calc={'+=':value+other,'-=':value-other,'*=':value*other,'/=':other?Math.trunc(value/other):value,'%=':other?value%other:value,'=':other,'<=':Math.min(value,other),'>=':Math.max(value,other)};
        if(!(op in calc))throw new Error('Unsupported scoreboard operation '+op);
        setScore(w,holder,objective,calc[op]);
      }
      return;
    }
  }
  if(cmd==='gamerule'){if(t[1])w.gamerules[t[1]]=t[2]??true;log(w,'info','gamerule '+t[1]+' = '+w.gamerules[t[1]]);return;}
  if(cmd==='time'){if(t[1]==='add')w.time+=Number(t[2]);else if(t[1]==='query')log(w,'info','time '+w.time);else w.time=t[2]==='day'?1000:t[2]==='noon'?6000:t[2]==='night'?13000:t[2]==='midnight'?18000:Number(t[2]);return;}
  if(cmd==='weather'){w.weather=t[1]||'clear';log(w,'info','weather set to '+w.weather);return;}
  if(cmd==='difficulty'){w.difficulty=t[1]||'normal';return;}
  if(cmd==='setworldspawn'){w.worldspawn=t.length>=4?parsePos(t.slice(1,4),origin):origin;return;}
  if(cmd==='spawnpoint'){log(w,'warning','Player spawn simulation is not implemented');return;}
  if(cmd==='schedule'){log(w,'warning','schedule is parsed but delayed tick execution is not simulated');return;}
  if(['data','advancement','loot','particle','playsound','effect','attribute','bossbar','team','worldborder','forceload','place','jigsaw','structure','recipe','give','clear','experience','xp'].includes(cmd)){
    log(w,'warning',cmd+' is a known Minecraft command but its game behavior is not implemented in this simulator'); return;
  }
  throw new Error('Unknown or unsupported command: '+cmd);
}
function parseFunction(source) {
  return source.split(/\r?\n/).map((line,index)=>({line:index+1,command:line.trim()})).filter(x=>x.command&&!x.command.startsWith('#'));
}
async function loadDatapack(buffer, world, name='uploaded datapack') {
  const zip=await JSZip.loadAsync(buffer);
  const files=Object.entries(zip.files).filter(([,entry])=>!entry.dir);
  const metaEntry=files.find(([file])=>file==='pack.mcmeta'||file.endsWith('/pack.mcmeta'));
  if(!metaEntry) throw new Error('Invalid datapack ZIP: pack.mcmeta was not found');
  const root=metaEntry[0].slice(0,metaEntry[0].length-'pack.mcmeta'.length);
  let meta;
  try{meta=JSON.parse(await metaEntry[1].async('string'));}catch{throw new Error('pack.mcmeta is not valid JSON');}
  const packFormat=meta.pack?.pack_format;
  if(!Number.isInteger(packFormat)) throw new Error('pack.mcmeta must contain pack.pack_format as an integer');
  let count=0;
  for(const [file,entry] of files){
    if(!file.startsWith(root)) continue;
    const rel=file.slice(root.length);
    const fn=rel.match(/^data\/([a-z0-9_.-]+)\/functions?\/(.+)\.mcfunction$/);
    if(fn){world.functions.set(fn[1]+':'+fn[2],parseFunction(await entry.async('string')));count++;}
  }
  if(count===0) log(world,'warning','No .mcfunction files were found in this ZIP');
  for(const [file,entry] of files){
    if(!file.startsWith(root))continue;
    const rel=file.slice(root.length);
    const tag=rel.match(/^data\/([a-z0-9_.-]+)\/tags\/functions?\/(load|tick)\.json$/);
    if(!tag)continue;
    try{
      const data=JSON.parse(await entry.async('string'));
      if(!Array.isArray(data.values))throw new Error('tag JSON needs a values array');
      for(const value of data.values){
        const id=typeof value==='string'?value:value?.id;
        if(!id)continue;
        if(tag[2]==='load')world.loadFunctions.push(id);
        else world.tickFunctions.push(id);
      }
    }catch(e){log(world,'error',rel+': '+e.message);}
  }
  world.packs.push({name,packFormat,functions:count});
  log(world,'success','Loaded '+name+' — '+count+' functions, pack format '+packFormat);
  const initialContext={pos:[0,64,0],entity:null};
  for(const id of world.loadFunctions) runFunction(world,id,initialContext,[]);
  return count;
}
function snapshot(w) {
  return {
    packs:w.packs, blocks:[...w.blocks.entries()].map(([k,block])=>({pos:k.split(',').map(Number),block})),
    entities:w.entities, functions:[...w.functions.keys()], loadFunctions:w.loadFunctions,
    tickFunctions:w.tickFunctions, objectives:[...w.objectives.keys()],
    scores:[...w.scores.entries()].map(([key,value])=>({key,value})),
    gamerules:w.gamerules,time:w.time,weather:w.weather,difficulty:w.difficulty,
    worldspawn:w.worldspawn,logs:w.logs,runCount:w.runCount
  };
}
function toolText(value){return {content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]};}
app.get('/api/health',(req,res)=>res.json({ok:true,name:'Minecraft Datapack Lab',version:'3.0.0',engine:'datapack-command-simulator',mcp:'/mcp',limits:LIMITS,supportedCommands:['function','execute as/at/positioned/if block/if entity/if score/run','setblock','fill','clone','summon','kill','tp','tag','scoreboard','gamerule','time','weather','difficulty','setworldspawn','say','tellraw']}));
app.post('/api/upload',upload.single('datapack'),async(req,res)=>{
  try{if(!req.file)throw new Error('Choose a datapack ZIP');const id=req.body.sessionId||'default',w=makeWorld();await loadDatapack(req.file.buffer,w,req.file.originalname||'uploaded datapack');sessions.set(id,w);res.json({ok:true,state:snapshot(w)});}
  catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/run',(req,res)=>{const w=sessions.get(req.body.sessionId||'default');if(!w)return res.status(404).json({error:'Upload a datapack first'});w.runCount=0;w.lastRun=req.body.function;runFunction(w,req.body.function,{pos:Array.isArray(req.body.origin)?req.body.origin:[0,64,0],entity:null},[]);res.json({ok:true,state:snapshot(w)});});
app.post('/api/tick',(req,res)=>{const w=sessions.get(req.body.sessionId||'default');if(!w)return res.status(404).json({error:'Upload a datapack first'});w.runCount=0;for(const id of w.tickFunctions)runFunction(w,id,{pos:[0,64,0],entity:null},[]);res.json({ok:true,state:snapshot(w)});});
app.post('/api/command',(req,res)=>{const w=sessions.get(req.body.sessionId||'default');if(!w)return res.status(404).json({error:'Upload a datapack first'});w.runCount=0;try{runCommand(w,String(req.body.command||''),{pos:[0,64,0],entity:null},[]);res.json({ok:true,state:snapshot(w)});}catch(e){log(w,'error',e.message);res.status(400).json({error:e.message,state:snapshot(w)});}});
app.post('/api/reset',(req,res)=>{sessions.set(req.body.sessionId||'default',makeWorld());res.json({ok:true});});
app.get('/api/state',(req,res)=>res.json(snapshot(sessions.get(req.query.sessionId||'default')||makeWorld())));
app.get('/mcp',(req,res)=>res.json({name:'Minecraft Datapack Lab MCP',version:'3.0.0',endpoint:'/mcp',transport:'HTTP JSON-RPC',methods:['initialize','tools/list','tools/call']}));
app.post('/mcp',async(req,res)=>{
  const message=req.body||{},id=message.id??null;
  const reply=result=>res.json({jsonrpc:'2.0',id,result});
  const error=(code,text)=>res.json({jsonrpc:'2.0',id,error:{code,message:text}});
  if(message.method==='initialize')return reply({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'minecraft-datapack-lab',version:'3.0.0'}});
  if(message.method==='notifications/initialized')return res.status(202).end();
  if(message.method==='ping')return reply({});
  if(message.method==='tools/list')return reply({tools:[
    {name:'upload_datapack',description:'Upload and load a datapack ZIP into the browser sandbox. Supply its ZIP bytes as base64.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},filename:{type:'string'},zipBase64:{type:'string'}},required:['zipBase64']}},
    {name:'list_functions',description:'List all loaded namespaced functions and load/tick tags.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}}}},
    {name:'run_function',description:'Execute a loaded namespaced function.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},function:{type:'string'},origin:{type:'array',items:{type:'number'}}},required:['function']}},
    {name:'run_tick',description:'Run every function registered in the datapack tick tag once.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}}}},
    {name:'run_command',description:'Run one supported Minecraft command in the simulator.',inputSchema:{type:'object',properties:{sessionId:{type:'string'},command:{type:'string'}},required:['command']}},
    {name:'get_world_state',description:'Inspect blocks, entities, scores, logs and loaded functions.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}}}},
    {name:'reset_world',description:'Clear the sandbox world and datapack session.',inputSchema:{type:'object',properties:{sessionId:{type:'string'}}}}
  ]});
  if(message.method==='tools/call'){
    const a=message.params?.arguments||{},sid=a.sessionId||'default',w=sessions.get(sid),name=message.params?.name;
    try{
      if(name==='upload_datapack'){
        if(typeof a.zipBase64!=='string'||a.zipBase64.length>45*1024*1024)return error(-32602,'zipBase64 is missing or too large');
        const fresh=makeWorld();await loadDatapack(Buffer.from(a.zipBase64,'base64'),fresh,a.filename||'MCP upload');sessions.set(sid,fresh);
        return reply(toolText({ok:true,state:snapshot(fresh)}));
      }
      if(name==='reset_world'){sessions.set(sid,makeWorld());return reply(toolText('World and datapack session reset'));}
      if(!w)return error(-32004,'No datapack is loaded in this session. Call upload_datapack first.');
      if(name==='get_world_state')return reply(toolText(snapshot(w)));
      if(name==='list_functions')return reply(toolText({functions:[...w.functions.keys()],loadFunctions:w.loadFunctions,tickFunctions:w.tickFunctions}));
      if(name==='run_function'){w.runCount=0;runFunction(w,a.function,{pos:Array.isArray(a.origin)?a.origin:[0,64,0],entity:null},[]);return reply(toolText(snapshot(w)));}
      if(name==='run_tick'){w.runCount=0;for(const f of w.tickFunctions)runFunction(w,f,{pos:[0,64,0],entity:null},[]);return reply(toolText(snapshot(w)));}
      if(name==='run_command'){w.runCount=0;runCommand(w,String(a.command||''),{pos:[0,64,0],entity:null},[]);return reply(toolText(snapshot(w)));}
      return error(-32601,'Unknown tool: '+name);
    }catch(e){return error(-32602,e.message);}
  }
  return error(-32601,'Method not found');
});
app.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log('Minecraft Datapack Lab v3 listening on '+(process.env.PORT||3000)));
