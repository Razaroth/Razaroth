/**
 * server.js
 *
 * Minimal MUD-style text MMORPG (single-file backend + frontend).
 *
 * Usage:
 * 1) npm install ws
 * 2) node server.js
 * 3) Open http://localhost:3000/
 *
 * This file implements:
 * - HTTP server serving a single-page HTML client
 * - WebSocket server for realtime text commands
 * - Simple world: rooms, items, players
 * - Commands: look, move <dir>, say <text>, who, name <new>, pickup <item>, inventory, attack <player>, help
 *
 * This is a starting point; extend rooms, commands, persistence, auth, etc.
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

/* ----- Simple world definition ----- */

const rooms = {
    gate: {
        id: 'gate',
        name: 'Town Gate',
        desc: 'You stand at the town gate. Dirt road leads north.',
        exits: { north: 'forest' },
        items: ['old-map'],
        players: new Set()
    },
    forest: {
        id: 'forest',
        name: 'Dark Forest',
        desc: 'A shadowy forest. You hear distant howls. Paths lead south and east.',
        exits: { south: 'gate', east: 'clearing' },
        items: ['stick'],
        players: new Set()
    },
    clearing: {
        id: 'clearing',
        name: 'Sunny Clearing',
        desc: 'A small clearing bathed in sunlight. There is a strange stone here.',
        exits: { west: 'forest' },
        items: ['strange-stone'],
        players: new Set()
    }
};

const players = new Map(); // id -> player

const CLASSES = {
    warrior: { name: 'Warrior', hp: 30, desc: 'High HP, melee fighter' },
    mage: { name: 'Mage', hp: 15, desc: 'Low HP, powerful spells' },
    rogue: { name: 'Rogue', hp: 20, desc: 'Balanced, quick attacks' },
    paladin: { name: 'Paladin', hp: 25, desc: 'Strong and holy' }
};

function createId() { return Math.random().toString(36).slice(2, 9); }

function defaultName() { return 'Guest' + Math.floor(Math.random() * 9000 + 1000); }

/* Player structure:
{
    id, name, ws, room, hp, maxHp, inventory: [], class: 'warrior'|'mage'|'rogue'|'paladin', classSelected
}
*/

function send(ws, type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, payload }));
    }
}

function broadcastToRoom(roomId, type, payload, excludeWs) {
    const room = rooms[roomId];
    if (!room) return;
    for (const pid of room.players) {
        const p = players.get(pid);
        if (p && p.ws && p.ws.readyState === WebSocket.OPEN && p.ws !== excludeWs) {
            send(p.ws, type, payload);
        }
    }
}

function describeRoomFor(player) {
    const r = rooms[player.room];
    const lines = [];
    lines.push(`${r.name}`);
    lines.push(r.desc);
    const exits = Object.keys(r.exits).join(', ') || 'none';
    lines.push(`Exits: ${exits}`);
    if (r.items.length) lines.push(`You see here: ${r.items.join(', ')}`);
    const others = Array.from(r.players)
        .filter(pid => pid !== player.id)
        .map(pid => players.get(pid).name);
    if (others.length) lines.push(`Also here: ${others.join(', ')}`);
    return lines.join('\n');
}

function joinRoom(player, roomId) {
    // remove from old
    if (player.room) {
        const old = rooms[player.room];
        if (old) old.players.delete(player.id);
        broadcastToRoom(player.room, 'message', `${player.name} leaves.`, player.ws);
    }
    player.room = roomId;
    const r = rooms[roomId];
    r.players.add(player.id);
    broadcastToRoom(roomId, 'message', `${player.name} arrives.`, player.ws);
    send(player.ws, 'message', describeRoomFor(player));
}

/* ----- Command handling ----- */

function handleCommand(player, raw) {
    const s = raw.trim();
    if (!s) return;
    const [cmd, ...rest] = s.split(/\s+/);
    const arg = rest.join(' ');

    switch (cmd.toLowerCase()) {
        case 'help':
            send(player.ws, 'message', [
                'Commands: look, move <dir>, say <text>, pickup <item>, inventory, attack <player>, who, name <new>, help'
            ].join('\n'));
            break;

        case 'look':
            send(player.ws, 'message', describeRoomFor(player));
            break;

        case 'move':
        case 'go':
            if (!arg) {
                send(player.ws, 'message', 'Move where? Usage: move <direction>');
                break;
            }
            {
                const r = rooms[player.room];
                const dest = r.exits[arg];
                if (!dest) {
                    send(player.ws, 'message', `You can't go ${arg}.`);
                } else {
                    joinRoom(player, dest);
                }
            }
            break;

        case 'say':
            if (!arg) {
                send(player.ws, 'message', 'Say what?');
            } else {
                broadcastToRoom(player.room, 'message', `${player.name} says: ${arg}`);
                send(player.ws, 'message', `You say: ${arg}`);
            }
            break;

        case 'who':
            send(player.ws, 'message', Array.from(players.values()).map(p => `${p.name} (${p.room})`).join('\n'));
            break;

        case 'name':
            if (!arg) {
                send(player.ws, 'message', 'Name what? Usage: name <newname>');
            } else {
                const old = player.name;
                player.name = arg.slice(0, 20);
                broadcastToRoom(player.room, 'message', `${old} is now known as ${player.name}.`);
                send(player.ws, 'message', `You are now ${player.name}.`);
            }
            break;

        case 'pickup':
        case 'take':
            if (!arg) { send(player.ws, 'message', 'Pickup what?'); break; }
            {
                const r = rooms[player.room];
                const idx = r.items.indexOf(arg);
                if (idx === -1) {
                    send(player.ws, 'message', `No "${arg}" here.`);
                } else {
                    r.items.splice(idx, 1);
                    player.inventory.push(arg);
                    broadcastToRoom(player.room, 'message', `${player.name} picks up ${arg}.`, player.ws);
                    send(player.ws, 'message', `You pick up ${arg}.`);
                }
            }
            break;

        case 'inventory':
        case 'inv':
            if (player.inventory.length === 0) send(player.ws, 'message', 'You carry nothing.');
            else send(player.ws, 'message', `You carry: ${player.inventory.join(', ')}`);
            break;

        case 'attack':
            if (!arg) { send(player.ws, 'message', 'Attack whom?'); break; }
            {
                const r = rooms[player.room];
                const targetPid = Array.from(r.players).find(pid => {
                    const p = players.get(pid);
                    return p && p.name.toLowerCase() === arg.toLowerCase();
                });
                if (!targetPid) {
                    send(player.ws, 'message', `No one named "${arg}" here.`);
                } else if (targetPid === player.id) {
                    send(player.ws, 'message', 'You cannot attack yourself.');
                } else {
                    const target = players.get(targetPid);
                    // simple damage
                    const damage = Math.floor(Math.random() * 8) + 1;
                    target.hp -= damage;
                    broadcastToRoom(player.room, 'message', `${player.name} attacks ${target.name} for ${damage} damage!`);
                    if (target.hp <= 0) {
                        broadcastToRoom(player.room, 'message', `${target.name} has fallen!`);
                        // drop inventory
                        if (target.inventory.length) {
                            rooms[player.room].items.push(...target.inventory);
                            broadcastToRoom(player.room, 'message', `${target.name} drops: ${target.inventory.join(', ')}`);
                            target.inventory = [];
                        }
                        // respawn
                        target.hp = target.maxHp;
                        send(target.ws, 'message', 'You are resurrected at the gate.');
                        joinRoom(target, 'gate');
                    } else {
                        send(target.ws, 'message', `You take ${damage} damage. HP: ${target.hp}/${target.maxHp}`);
                    }
                }
            }
            break;

        default:
            send(player.ws, 'message', `Unknown command: ${cmd}. Try "help".`);
    }
}

/* ----- HTTP + WebSocket server ----- */

const htmlClient = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minimal MUD - Epic Edition</title>
<style>
:root{--primary:#6366f1;--secondary:#8b5cf6;--danger:#ef4444;--success:#10b981;--accent:#fbbf24;--text:#f1f5f9;--muted:#94a3b8;--dark1:#0f172a;--dark2:#1e293b;--dark3:#334155}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Roboto,'Helvetica Neue',sans-serif;background:linear-gradient(135deg,#0f172a 0%,#1a1a4d 50%,#1e1a4d 100%);color:var(--text);height:100vh;display:flex;align-items:stretch;overflow:hidden}
@keyframes glow{0%,100%{text-shadow:0 0 10px rgba(99,102,241,0.5)}50%{text-shadow:0 0 20px rgba(139,92,246,0.8)}}
@keyframes fadeIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
.header{position:absolute;top:12px;left:50%;transform:translateX(-50%);text-align:center;pointer-events:none;z-index:1}
.header-title{font-size:20px;font-weight:700;letter-spacing:2px;color:var(--primary);animation:glow 3s ease-in-out infinite;text-shadow:0 0 15px rgba(99,102,241,0.6)}
.container{display:grid;grid-template-columns:1fr 380px;gap:20px;padding:60px 24px 24px;width:100%;max-width:1600px;margin:auto;height:100vh;overflow:auto}
.panel{background:rgba(30,41,59,0.6);backdrop-filter:blur(10px);border:1px solid rgba(148,163,184,0.1);padding:16px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.3)}
.panel.hero{background:linear-gradient(135deg,rgba(99,102,241,0.1),rgba(139,92,246,0.1));border:1px solid rgba(99,102,241,0.2)}
#log{height:calc(100vh - 220px);overflow-y:auto;padding:16px;background:rgba(15,23,42,0.4);border-radius:12px;scrollbar-width:thin;scrollbar-color:var(--primary) transparent}
#log::-webkit-scrollbar{width:8px}
#log::-webkit-scrollbar-track{background:transparent}
#log::-webkit-scrollbar-thumb{background:var(--primary);border-radius:4px}
.inputRow{display:flex;gap:12px;margin-top:16px}
#cmdInput{flex:1;padding:14px 16px;border-radius:12px;background:rgba(20,35,60,0.8);border:2px solid rgba(99,102,241,0.2);color:var(--text);font-size:14px;transition:all 300ms ease}
#cmdInput:focus{outline:none;border-color:var(--primary);background:rgba(20,35,60,1);box-shadow:0 0 20px rgba(99,102,241,0.3)}
#sendBtn{padding:12px 20px;border-radius:12px;background:linear-gradient(135deg,var(--primary),var(--secondary));border:none;color:#fff;cursor:pointer;font-weight:700;transition:all 300ms ease;box-shadow:0 4px 15px rgba(99,102,241,0.3)}
#sendBtn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(99,102,241,0.5)}
#sendBtn:active{transform:translateY(0)}
.msg{white-space:pre-wrap;margin:10px 0;padding:12px;border-radius:12px;display:flex;gap:12px;align-items:flex-start;animation:fadeIn 300ms ease forwards}
.msg .time{font-size:11px;color:var(--muted);min-width:70px;font-weight:500}
.msg.system{color:var(--primary);background:rgba(99,102,241,0.08);border-left:3px solid var(--primary)}
.msg.self{background:rgba(16,185,129,0.08);border-left:3px solid var(--success)}
.msg.other{background:rgba(148,163,184,0.04);border-left:3px solid var(--muted)}
.msg .icon{font-size:16px;opacity:1}
.sidebar{display:flex;flex-direction:column;gap:16px;max-height:100%}
.status{background:linear-gradient(135deg,rgba(99,102,241,0.12),rgba(139,92,246,0.08));padding:16px;border-radius:12px;border:1px solid rgba(99,102,241,0.15)}
.statRow{display:flex;justify-content:space-between;align-items:center;margin:8px 0}
.statRow:first-child{margin-top:0}
.hpBar{height:14px;background:rgba(0,0,0,0.3);border-radius:8px;overflow:hidden;border:1px solid rgba(99,102,241,0.2);margin-top:4px}
.hpFill{height:100%;background:linear-gradient(90deg,var(--success),#34d399);width:100%;transition:width 400ms cubic-bezier(.25,.46,.45,.94);box-shadow:0 0 10px rgba(16,185,129,0.5)}
.exits,.items,.inventory,.players{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.chip{padding:8px 12px;background:rgba(99,102,241,0.12);border-radius:10px;border:1px solid rgba(99,102,241,0.25);cursor:pointer;font-size:13px;color:var(--text);transition:all 200ms ease;white-space:nowrap}
.chip:hover{background:rgba(99,102,241,0.2);border-color:var(--primary);transform:translateY(-2px)}
.playerChip{background:rgba(139,92,246,0.15);border-color:rgba(139,92,246,0.3)}
.playerChip:hover{background:rgba(139,92,246,0.25)}
.small{font-size:12px;color:var(--muted)}
.title{font-weight:700;font-size:14px;color:var(--primary);text-transform:uppercase;letter-spacing:1px;margin:12px 0 8px 0}
.toolbar{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:8px 12px;border-radius:10px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.2);color:var(--text);cursor:pointer;font-size:13px;transition:all 200ms ease}
.btn:hover{background:rgba(99,102,241,0.2);border-color:var(--primary);transform:translateY(-2px)}
.footer{margin-top:auto;font-size:11px;color:var(--muted);padding:12px;border-top:1px solid rgba(99,102,241,0.1);text-align:center}
.muted{color:var(--muted)}
@media(max-width:1000px){.container{grid-template-columns:1fr}.sidebar{max-height:40vh;border:1px solid rgba(99,102,241,0.1)}}
</style>
</head>
<body>
<div class="header">
  <div class="header-title">MINIMAL MUD</div>
</div>
<div class="container">
  <div class="panel hero">
    <div id="log" aria-live="polite"></div>
    <div class="inputRow">
      <input id="cmdInput" placeholder="Type command (help) and press Enter..." aria-label="Command input" autocomplete="off" />
      <button id="sendBtn">Send</button>
    </div>
    <div class="toolbar">
      <button class="btn" id="btnHelp">Help</button>
      <button class="btn" id="btnLook">Look</button>
      <button class="btn" id="btnWho">Who</button>
      <button class="btn" id="btnInv">Inventory</button>
    </div>
  </div>
    <div class="sidebar">
    <div class="panel status">
      <div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Status</div>
      <div class="statRow"><div>Player</div><div id="playerName" style="color:var(--primary);font-weight:700">-</div></div>
      <div class="statRow"><div>Class</div><div id="playerClass" style="color:var(--secondary);font-weight:700">-</div></div>
      <div class="statRow"><div>HP</div><div id="hp" style="color:var(--success)">-</div></div>
      <div class="hpBar"><div id="hpFill" class="hpFill"></div></div>
      <div class="statRow"><div>Location</div><div id="roomName" style="color:var(--accent)">-</div></div>
    </div>
    <div class="panel">
      <div class="title">Exits</div>
      <div id="exits" class="exits small"></div>
    </div>
    <div class="panel">
      <div class="title">Items</div>
      <div id="items" class="items small"></div>
    </div>
    <div class="panel">
      <div class="title">Players <span id="playerCount" class="small muted">(0)</span></div>
      <div id="players" class="players small"></div>
    </div>
    <div class="panel">
      <div class="title">Inventory</div>
      <div id="inventory" class="inventory small"></div>
    </div>
    <div class="panel">
      <div class="toolbar">
        <button id="btnName" class="btn">Name</button>
        <button id="btnRespawn" class="btn">Refresh</button>
      </div>
    </div>
    <div class="footer">Click to interact - Type / to focus - Up arrow for history</div>
  </div>
</div>

<script>
const logEl = document.getElementById('log');
const inputEl = document.getElementById('cmdInput');
const sendBtn = document.getElementById('sendBtn');
const playerNameEl = document.getElementById('playerName');
const playerClassEl = document.getElementById('playerClass');
const hpEl = document.getElementById('hp');
const hpFillEl = document.getElementById('hpFill');
const roomNameEl = document.getElementById('roomName');
const exitsEl = document.getElementById('exits');
const itemsEl = document.getElementById('items');
const invEl = document.getElementById('inventory');
const playersEl = document.getElementById('players');
const playerCountEl = document.getElementById('playerCount');

console.log('DOM elements loaded:', {logEl, inputEl, sendBtn, playerNameEl});

const ICONS = { system: '[!]', self: '>', other: '*', item: '[o]', exit: '->', player: '@' };

const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
console.log('WebSocket created:', ws);

try{
    inputEl.disabled = false;
    inputEl.readOnly = false;
    inputEl.tabIndex = 0;
    inputEl.spellcheck = false;
    inputEl.style.color = 'var(--text)';
    inputEl.style.zIndex = 2;
}catch(e){console.error('Input setup error:', e);}

window.addEventListener('error', function(ev) {
    console.error('[JS ERROR]', ev.message, 'at', ev.filename + ':' + ev.lineno);
    try { 
        const msg = '[JS ERROR] ' + ev.message + ' at ' + ev.filename + ':' + ev.lineno;
        if(logEl) logEl.innerHTML += '<div style="color:red;padding:8px;margin:8px 0;background:rgba(255,0,0,0.1)">' + msg + '</div>';
    } catch(e) { console.error(e); }
});
window.addEventListener('unhandledrejection', function(ev) {
    console.error('[Promise Rejection]', ev.reason);
    try { 
        const msg = '[Promise Rejection] ' + (ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason));
        if(logEl) logEl.innerHTML += '<div style="color:red;padding:8px;margin:8px 0;background:rgba(255,0,0,0.1)">' + msg + '</div>';
    } catch(e) { console.error(e); }
});

function nowTime(){ const d=new Date(); return d.toLocaleTimeString(); }

function addMessage(text, cls){
    const d = document.createElement('div');
    d.className = 'msg ' + (cls||'other');
    const time = document.createElement('div'); time.className='time'; time.textContent = nowTime();
    const icon = document.createElement('div'); icon.className='icon'; icon.textContent = ICONS[cls] || ICONS.other;
    const body = document.createElement('div'); body.style.flex='1'; body.textContent = text;
    d.appendChild(time); d.appendChild(icon); d.appendChild(body);
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
    return d;
}

let history = []; let histIdx = -1;

function sendCmd(cmd){
    if(!cmd) return;
    if(ws.readyState !== WebSocket.OPEN) { addMessage('[SYSTEM] Not connected', 'system'); return }
    addMessage('> ' + cmd, 'self');
    ws.send(JSON.stringify({ type: 'cmd', payload: cmd }));
    history.push(cmd); histIdx = history.length;
}

ws.onopen = () => {
    console.log('WebSocket opened');
    addMessage('Connected to server', 'system');
    addMessage('UI ready - try typing a command (help)', 'system');
};
ws.onclose = () => {
    console.log('WebSocket closed');
    addMessage('Disconnected from server', 'system');
};
ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    addMessage('WebSocket error', 'system');
};

if(logEl) logEl.innerHTML += '<div class="msg system"><div class="time">' + nowTime() + '</div><div class="icon">[!]</div><div style="flex:1">Connecting...</div></div>';
console.log('Initial message added to log');

function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }

ws.onmessage = (ev) => {
    try{
        const data = JSON.parse(ev.data);
        if(data.type === 'message') {
            addMessage(data.payload, 'other');
            const lines = data.payload.split('\\n');
            const title = lines.find(l=>l.trim());
            if(title) roomNameEl.textContent = title;
            const exitsLine = lines.find(l=>l.startsWith('Exits:')) || ''; renderExits(exitsLine.replace('Exits:','').trim());
            const itemsLine = lines.find(l=>l.startsWith('You see here:')) || ''; renderItems(itemsLine.replace('You see here:','').trim());
            const alsoLine = lines.find(l=>l.startsWith('Also here:')) || ''; renderPlayers(alsoLine.replace('Also here:','').trim());
            if(data.payload.includes('You carry:')){ renderInventory(data.payload.replace('You carry:','').trim()); }
            if(data.payload.includes('HP:')){
                const m=data.payload.match(/HP:\\s*(\\d+)\\/(\\d+)/);
                if(m){ const cur=Number(m[1]), max=Number(m[2]); hpEl.textContent = cur + '/' + max; const pct = clamp(Math.round((cur/max)*100),0,100); hpFillEl.style.width = pct + '%'; }
            }
            if(data.payload.startsWith('You are now') || data.payload.startsWith('Welcome,')){
                const m = data.payload.match(/Welcome,\\s*(\\S+)/) || data.payload.match(/You are now\\s*(\\S+)/);
                if(m) playerNameEl.textContent = m[1];
            }
        } else if(data.type === 'system'){
            addMessage('[SYSTEM] ' + data.payload, 'system');
            if(data.payload.startsWith('Welcome,')){
                const m = data.payload.match(/Welcome,\\s*(\\S+)/);
                if(m) playerNameEl.textContent = m[1];
                setTimeout(()=>{ sendCmd('look'); sendCmd('inventory'); }, 120);
            }
            if(data.payload.startsWith('You are now a')){
                const m = data.payload.match(/You are now a\\s*(\\w+)/i);
                if(m) playerClassEl.textContent = m[1];
            }
        }
    }catch(e){ addMessage('Bad message: ' + ev.data,'system') }
}

function renderExits(exitsStr){
    exitsEl.innerHTML = '';
    if(!exitsStr) return;
    exitsStr.split(',').map(s=>s.trim()).filter(Boolean).forEach(dir=>{
        const b = document.createElement('button');
        b.className = 'chip'; b.textContent = '-> ' + dir; b.title = 'Move ' + dir;
        b.onclick = ()=> sendCmd('move ' + dir);
        exitsEl.appendChild(b);
    });
}

function renderItems(itemsStr){
    itemsEl.innerHTML = '';
    if(!itemsStr) return;
    itemsStr.split(',').map(s=>s.trim()).filter(Boolean).forEach(it=>{
        const b = document.createElement('button');
        b.className = 'chip'; b.textContent = '[o] ' + it; b.title = 'Pickup ' + it;
        b.onclick = ()=> sendCmd('pickup ' + it);
        itemsEl.appendChild(b);
    });
}

function renderPlayers(playersStr){
    playersEl.innerHTML = '';
    if(!playersStr){ playerCountEl.textContent = '(0)'; return; }
    const arr = playersStr.split(',').map(s=>s.trim()).filter(Boolean);
    playerCountEl.textContent = '(' + arr.length + ')';
    arr.forEach(name=>{
        const b = document.createElement('button');
        b.className = 'chip playerChip'; b.textContent = '@ ' + name; b.title = 'Click to interact';
        b.onclick = ()=>{
            const action = prompt('Action for ' + name + ': type attack or a message', 'attack');
            if(!action) return;
            if(action.toLowerCase() === 'attack') sendCmd('attack ' + name);
            else sendCmd('say ' + action);
        };
        playersEl.appendChild(b);
    });
}

function renderInventory(invStr){
    invEl.innerHTML = '';
    if(!invStr) return;
    invStr.split(',').map(s=>s.trim()).filter(Boolean).forEach(it=>{
        const d = document.createElement('div'); d.className='chip'; d.textContent='[o] ' + it; invEl.appendChild(d);
    });
}

sendBtn.addEventListener('click', ()=>{ const t = inputEl.value.trim(); if(t){ sendCmd(t); inputEl.value=''; inputEl.focus(); } });
inputEl.addEventListener('keydown', (e)=>{
    if(e.key==='Enter'){ sendBtn.click(); }
    else if(e.key==='ArrowUp'){ if(history.length){ histIdx = Math.max(0, histIdx-1); inputEl.value = history[histIdx] || ''; } }
    else if(e.key==='ArrowDown'){ if(history.length){ histIdx = Math.min(history.length, histIdx+1); inputEl.value = history[histIdx] || ''; } }
    else if(e.key==='/' && document.activeElement !== inputEl){ e.preventDefault(); inputEl.focus(); }
});

document.getElementById('btnHelp').addEventListener('click', ()=> sendCmd('help'));
document.getElementById('btnLook').addEventListener('click', ()=> sendCmd('look'));
document.getElementById('btnWho').addEventListener('click', ()=> sendCmd('who'));
document.getElementById('btnInv').addEventListener('click', ()=> sendCmd('inventory'));
document.getElementById('btnName').addEventListener('click', ()=>{
    const n = prompt('Enter new name (max 20 chars):', playerNameEl.textContent || '');
    if(n) sendCmd('name ' + n);
});
document.getElementById('btnRespawn').addEventListener('click', ()=> sendCmd('look'));

inputEl.focus();
window.addEventListener('keydown', (e)=>{ if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); inputEl.focus(); } });
</script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
    const u = url.parse(req.url);
    if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlClient);
        return;
    }
    // lightweight fallback client for debugging WebSocket / input issues
    if (u.pathname === '/simple') {
        const simple = '<!doctype html><html><head><meta charset="utf-8"><title>Simple MUD Client</title></head><body style="background:#000;color:#fff;font-family:monospace;padding:16px;"><div id="log" style="white-space:pre-wrap;height:60vh;overflow:auto;border:1px solid #333;padding:8px;margin-bottom:8px;background:#111"></div><input id="cmd" placeholder="type command" style="width:80%;padding:8px"><button id="send" style="padding:8px">Send</button><script>const log=document.getElementById("log");const inp=document.getElementById("cmd");const btn=document.getElementById("send");const ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/ws");ws.onopen=()=>log.textContent+="[WS OPEN]\\n";ws.onclose=()=>log.textContent+="[WS CLOSED]\\n";ws.onerror=(e)=>log.textContent+="[WS ERR] "+String(e)+"\\n";ws.onmessage=(m)=>{try{const d=JSON.parse(m.data);log.textContent+=(d.type==="system"?"[SYS] ":"")+d.payload+"\\n";}catch(e){log.textContent+=m.data+"\\n";}};const send=()=>{const v=inp.value.trim();if(!v)return;ws.send(JSON.stringify({type:"cmd",payload:v}));log.textContent+="> "+v+"\\n";inp.value="";inp.focus();};btn.addEventListener("click",send);inp.addEventListener("keydown",(e)=>{if(e.key==="Enter"){e.preventDefault();send();}});</script></body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(simple);
        return;
    }
    res.writeHead(404);
    res.end('Not found');
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const u = url.parse(req.url);
    console.log('HTTP upgrade requested:', req.url, 'Upgrade header:', req.headers['upgrade']);
    if (u.pathname === '/ws') {
        console.log('Handling WebSocket upgrade for', req.url);
        wss.handleUpgrade(req, socket, head, (ws) => {
            console.log('Completed handleUpgrade, emitting connection');
            wss.emit('connection', ws, req);
        });
    } else {
        console.log('Unknown upgrade path, destroying socket:', req.url);
        socket.destroy();
    }
});

wss.on('connection', (ws) => {
    const pid = createId();
    const player = {
        id: pid,
        name: defaultName(),
        ws,
        room: null,
        hp: 20,
        maxHp: 20,
        inventory: [],
        class: null,
        classSelected: false
    };
    players.set(pid, player);
    console.log('WS connection:', pid);
    
    const classOptions = Object.entries(CLASSES)
        .map(([key, cls]) => key + ': ' + cls.name + ' (' + cls.desc + ')')
        .join(' | ');
    send(ws, 'system', 'Welcome, ' + player.name + '! Choose your class: ' + classOptions);
    player.awaitingClass = true;

    ws.on('message', (msg) => {
        let data;
        try { data = JSON.parse(msg); } catch (e) { return send(ws, 'system', 'Invalid message format'); }
        console.log('WS message from', pid, data);
        if (data.type === 'cmd') {
            const cmd = String(data.payload || '').toLowerCase().trim();
            
            // Handle class selection
            if (player.awaitingClass && !player.classSelected) {
                if (cmd in CLASSES) {
                    player.class = cmd;
                    player.hp = CLASSES[cmd].hp;
                    player.maxHp = CLASSES[cmd].hp;
                    player.classSelected = true;
                    player.awaitingClass = false;
                    send(ws, 'system', 'You are now a ' + CLASSES[cmd].name + '! HP: ' + player.hp);
                    joinRoom(player, 'gate');
                    handleCommand(player, 'look');
                } else {
                    send(ws, 'system', 'Invalid class. Choose from: ' + Object.keys(CLASSES).join(', '));
                }
                return;
            }
            
            handleCommand(player, cmd);
        }
    });

    ws.on('close', () => {
        // remove player
        if (player.room) {
            const r = rooms[player.room];
            if (r) r.players.delete(pid);
            broadcastToRoom(player.room, 'message', `${player.name} has disconnected.`);
        }
        players.delete(pid);
    });
});

/* ----- Simple periodic regen tick ----- */
setInterval(() => {
    for (const p of players.values()) {
        if (p.hp < p.maxHp) {
            p.hp = Math.min(p.maxHp, p.hp + 1);
            send(p.ws, 'message', `You feel slightly better. HP: ${p.hp}/${p.maxHp}`);
        }
    }
}, 15000);

/* Start server */
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});