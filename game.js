'use strict';

/* =============================================================
   MousseOver — V1
   -------------------------------------------------------------
   - Site 100 % statique (GitHub Pages).
   - Multijoueur avec PeerJS (WebRTC) : les navigateurs se parlent
     directement. Le serveur gratuit de PeerJS sert seulement à les
     mettre en relation.
   - Le créateur du salon est "l'hôte" : c'est SON navigateur qui
     fait tourner la partie (cercle, lasers, bombes, morts) et qui
     envoie l'état du jeu aux autres 20 fois par seconde.
   - Les autres joueurs envoient juste la position de leur souris.
   ============================================================= */

// ---------- Réglages du jeu (modifie-les librement) ----------
const CFG = {
  ARENA: 1000,            // taille de l'arène en "unités" (adaptée à chaque écran)
  MAX_PLAYERS: 5,
  CURSOR_R: 7,            // rayon de collision d'une souris

  START_R: 460,           // rayon de départ du cercle
  MIN_R: 80,              // rayon minimum
  SHRINK_EVERY: 10000,    // le cercle rétrécit toutes les 10 s
  SHRINK_FACTOR: 0.8,     // il garde 80 % de sa taille à chaque fois
  SHRINK_ANIM: 1500,      // durée de l'animation de rétrécissement

  COUNTDOWN: 3000,        // décompte avant le début

  LASER_FIRST: 3000,      // délai avant le premier laser
  LASER_EVERY: 2600,      // intervalle entre deux lasers au début
  LASER_EVERY_MIN: 1000,  // intervalle minimum
  LASER_WARN: 1500,       // durée de l'avertissement (rectangle qui clignote)
  LASER_BLINKS: 4,        // nombre de clignotements
  LASER_SWEEP: 400,       // temps pour que le laser traverse l'écran
  LASER_HOLD: 350,        // le laser reste allumé un peu après
  LASER_W: 36,            // épaisseur du laser
  LASER_LEN: 4000,        // longueur (assez pour traverser tout l'écran)

  BOMB_FROM_SHRINK: 3,    // les bombes arrivent au 3e rétrécissement
  BOMB_EVERY: 3500,       // une vague de bombes toutes les 3,5 s
  BOMB_FUSE: 1500,        // temps avant explosion
  BOMB_R: 65,             // rayon de l'explosion
  BOMB_FLASH: 350,        // durée de l'explosion (mortelle pendant ce temps)

  NET_RATE: 50,           // l'hôte envoie l'état toutes les 50 ms
  MOUSE_RATE: 33,         // un joueur envoie sa souris toutes les 33 ms max
  ID_PREFIX: 'mousseover-v1-',
};

const COLORS = ['#4fc3f7', '#ff8a65', '#aed581', '#ba68c8', '#ffd54f'];
const CAUSES = {
  cercle: 'touché le bord du cercle',
  laser: 'touché par un laser',
  bombe: 'pris dans une explosion',
  sorti: 'souris sortie de la fenêtre',
  parti: 'déconnecté',
};

// ---------- Petits utilitaires ----------
const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const ease = (k) => 1 - Math.pow(1 - k, 3);
const cleanName = (n) => String(n || '').trim().slice(0, 12) || 'Joueur';

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// Rayon du cercle à l'instant t (avec l'animation de rétrécissement)
function circleRadius(c, t) {
  if (t <= c.s) return c.rFrom;
  const k = Math.min(1, (t - c.s) / CFG.SHRINK_ANIM);
  return c.rFrom + (c.rTo - c.rFrom) * ease(k);
}

// Un laser touche-t-il ce point ?
function laserHits(l, x, y, t) {
  const fireStart = l.born + CFG.LASER_WARN;
  if (t < fireStart) return false;
  const prog = Math.min(1, (t - fireStart) / CFG.LASER_SWEEP);
  const dx = x - l.x, dy = y - l.y;
  const c = Math.cos(l.a), s = Math.sin(l.a);
  const u = dx * c + dy * s;   // position le long du laser
  const v = -dx * s + dy * c;  // distance perpendiculaire au laser
  const half = CFG.LASER_LEN / 2;
  return Math.abs(v) < CFG.LASER_W / 2 + CFG.CURSOR_R && u >= -half && u <= -half + prog * CFG.LASER_LEN;
}

// Une bombe touche-t-elle ce point ?
function bombHits(b, x, y, t) {
  const age = t - b.born;
  if (age < CFG.BOMB_FUSE || age > CFG.BOMB_FUSE + CFG.BOMB_FLASH) return false;
  return Math.hypot(x - b.x, y - b.y) < CFG.BOMB_R + CFG.CURSOR_R;
}

// ---------- État local ----------
const me = { x: 500, y: 500, inside: true, dirty: true, lastSent: 0 };
let net = null;        // { peer, isHost, myId, conn, leaving }
let host = null;       // logique de la partie (seulement chez l'hôte)
let view = null;       // dernier état reçu de l'hôte
let clockOffset = null; // horloge de l'hôte - horloge locale
let currentPhase = null;
const smooth = new Map(); // positions lissées des autres joueurs

// =============================================================
//  1. UN SEUL ONGLET PAR NAVIGATEUR
//  Le premier onglet prend un "verrou". Les suivants ne peuvent
//  pas l'avoir et affichent un message.
// =============================================================
function acquireTabLock() {
  if (!navigator.locks) return Promise.resolve(true); // vieux navigateur : on laisse passer
  return new Promise((resolve) => {
    navigator.locks.request('mousseover-tab', { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      return new Promise(() => {}); // on garde le verrou tant que l'onglet est ouvert
    });
  });
}

// =============================================================
//  2. LOGIQUE DE PARTIE (tourne uniquement chez l'hôte)
// =============================================================
function createHostState(solo) {
  return {
    solo, code: '', phase: 'lobby',
    players: new Map(), conns: new Map(),
    circle: null, lasers: [], bombs: [], shrinks: 0,
    t0: 0, nextShrink: 0, nextLaser: 0, nextBomb: Infinity,
    nextId: 1, winner: null, endTime: 0, lastSend: 0, timer: null,
  };
}

function hostAddPlayer(id, name) {
  const used = new Set([...host.players.values()].map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || '#ffffff';
  host.players.set(id, { id, name, color, x: 500, y: 500, inside: true, alive: true, cause: null, survived: 0, gone: false });
}

function hostStartGame() {
  const t = now();
  host.phase = 'countdown';
  host.t0 = t + CFG.COUNTDOWN;
  host.circle = { x: 500, y: 500, rFrom: CFG.START_R, rTo: CFG.START_R, s: 0 };
  host.lasers = [];
  host.bombs = [];
  host.shrinks = 0;
  host.nextShrink = host.t0 + CFG.SHRINK_EVERY;
  host.nextLaser = host.t0 + CFG.LASER_FIRST;
  host.nextBomb = Infinity;
  host.winner = null;
  host.endTime = 0;
  for (const p of host.players.values()) { p.alive = true; p.cause = null; p.survived = 0; }
}

function hostBackToLobby() {
  host.phase = 'lobby';
  host.circle = null;
  host.lasers = [];
  host.bombs = [];
  for (const [id, p] of host.players) if (p.gone) host.players.delete(id);
}

function hostSpawnLaser(t) {
  const r = circleRadius(host.circle, t);
  const d = Math.random() * r * 0.85;     // le laser passe par un point du cercle
  const pa = Math.random() * Math.PI * 2;
  host.lasers.push({
    id: host.nextId++,
    x: 500 + Math.cos(pa) * d,
    y: 500 + Math.sin(pa) * d,
    a: Math.random() * Math.PI * 2,       // direction au hasard
    born: t,
  });
}

function hostSpawnBombs(t) {
  for (const p of host.players.values()) {
    if (p.alive) host.bombs.push({ id: host.nextId++, x: p.x, y: p.y, born: t });
  }
}

function hostKill(p, t, cause) {
  p.alive = false;
  p.cause = cause;
  p.survived = Math.max(0, t - host.t0);
}

function hostTick() {
  const t = now();

  if (host.phase === 'countdown' && t >= host.t0) host.phase = 'playing';

  if (host.phase === 'playing') {
    // Rétrécissement
    if (t >= host.nextShrink) {
      const r = circleRadius(host.circle, t);
      host.circle = { x: 500, y: 500, rFrom: r, rTo: Math.max(CFG.MIN_R, r * CFG.SHRINK_FACTOR), s: t };
      host.shrinks++;
      host.nextShrink = t + CFG.SHRINK_EVERY;
      if (host.shrinks === CFG.BOMB_FROM_SHRINK) host.nextBomb = t + 1000;
    }

    // Lasers (de plus en plus fréquents)
    if (t >= host.nextLaser) {
      const count = host.shrinks >= 5 ? 2 : 1;
      for (let i = 0; i < count; i++) hostSpawnLaser(t);
      host.nextLaser = t + Math.max(CFG.LASER_EVERY_MIN, CFG.LASER_EVERY - host.shrinks * 250);
    }

    // Bombes
    if (t >= host.nextBomb) {
      hostSpawnBombs(t);
      host.nextBomb = t + CFG.BOMB_EVERY;
    }

    // Nettoyage
    host.lasers = host.lasers.filter((l) => t < l.born + CFG.LASER_WARN + CFG.LASER_SWEEP + CFG.LASER_HOLD);
    host.bombs = host.bombs.filter((b) => t < b.born + CFG.BOMB_FUSE + CFG.BOMB_FLASH);

    // Collisions
    const r = circleRadius(host.circle, t);
    for (const p of host.players.values()) {
      if (!p.alive) continue;
      let cause = null;
      if (!p.inside) cause = 'sorti';
      else if (Math.hypot(p.x - 500, p.y - 500) + CFG.CURSOR_R >= r) cause = 'cercle';
      else if (host.lasers.some((l) => laserHits(l, p.x, p.y, t))) cause = 'laser';
      else if (host.bombs.some((b) => bombHits(b, p.x, p.y, t))) cause = 'bombe';
      if (cause) hostKill(p, t, cause);
    }

    // Fin de partie ?
    const all = [...host.players.values()];
    const alive = all.filter((p) => p.alive);
    const over = (host.solo || all.length === 1) ? alive.length === 0 : alive.length <= 1;
    if (over) {
      host.phase = 'over';
      host.endTime = t;
      host.winner = alive.length === 1 ? alive[0].id : null;
      for (const p of alive) p.survived = t - host.t0;
    }
  }

  if (t - host.lastSend >= CFG.NET_RATE) {
    host.lastSend = t;
    hostBroadcast(t);
  }
}

function hostBroadcast(t) {
  const msg = {
    t: 'state',
    now: t,
    phase: host.phase,
    solo: host.solo,
    code: host.code,
    t0: host.t0,
    circle: host.circle,
    shrinks: host.shrinks,
    nextShrink: host.nextShrink,
    winner: host.winner,
    endTime: host.endTime,
    lasers: host.lasers,
    bombs: host.bombs,
    players: [...host.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color,
      x: Math.round(p.x), y: Math.round(p.y),
      alive: p.alive, cause: p.cause, survived: p.survived, gone: p.gone,
    })),
  };
  for (const c of host.conns.values()) if (c.open) c.send(msg);
  onState(msg); // l'hôte s'affiche aussi l'état
}

// =============================================================
//  3. RÉSEAU (PeerJS)
// =============================================================
function startHosting(name, attempt = 0) {
  const code = randomCode();
  setMenuBusy(true, 'Création du salon…');
  const peer = new Peer(CFG.ID_PREFIX + code);

  peer.on('open', (id) => {
    net = { peer, isHost: true, myId: id, conn: null, leaving: false };
    host = createHostState(false);
    host.code = code;
    hostAddPlayer(id, name);
    host.timer = setInterval(hostTick, 16);
    peer.on('connection', hostOnConnection);
    setMenuBusy(false);
  });

  peer.on('disconnected', () => {
    // Perte du serveur de mise en relation : les parties en cours continuent,
    // on se reconnecte juste pour accepter de nouveaux joueurs.
    if (net && net.peer === peer && !net.leaving && !peer.destroyed) peer.reconnect();
  });

  peer.on('error', (err) => {
    if (net && net.peer === peer) { console.warn('PeerJS', err); return; }
    peer.destroy();
    if (err.type === 'unavailable-id' && attempt < 5) { startHosting(name, attempt + 1); return; }
    setMenuBusy(false);
    menuError('Impossible de créer le salon (' + err.type + ').');
  });
}

function hostOnConnection(conn) {
  conn.on('data', (msg) => hostOnMessage(conn, msg));
  conn.on('close', () => hostOnLeave(conn));
  conn.on('error', () => hostOnLeave(conn));
}

function hostReject(conn, reason) {
  conn.send({ t: 'reject', reason });
  setTimeout(() => conn.close(), 500);
}

function hostOnMessage(conn, msg) {
  if (!host || !msg) return;
  if (msg.t === 'hello') {
    if (host.players.has(conn.peer)) return;
    if (host.players.size >= CFG.MAX_PLAYERS) return hostReject(conn, 'full');
    if (host.phase !== 'lobby') return hostReject(conn, 'started');
    host.conns.set(conn.peer, conn);
    hostAddPlayer(conn.peer, cleanName(msg.name));
    conn.send({ t: 'welcome' });
  } else if (msg.t === 'mouse') {
    const p = host.players.get(conn.peer);
    if (!p) return;
    p.x = Number(msg.x) || 0;
    p.y = Number(msg.y) || 0;
    p.inside = !!msg.inside;
  }
}

function hostOnLeave(conn) {
  if (!host) return;
  host.conns.delete(conn.peer);
  const p = host.players.get(conn.peer);
  if (!p) return;
  if (host.phase === 'lobby') {
    host.players.delete(conn.peer);
  } else {
    if (p.alive && host.phase !== 'over') hostKill(p, now(), 'parti');
    p.gone = true;
  }
}

function joinRoom(name, code) {
  setMenuBusy(true, 'Connexion au salon ' + code + '…');
  const peer = new Peer();
  let done = false;

  const fail = (text) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    peer.destroy();
    setMenuBusy(false);
    menuError(text);
  };
  const timeout = setTimeout(() => fail('Impossible de rejoindre le salon (délai dépassé).'), 10000);

  peer.on('open', () => {
    const conn = peer.connect(CFG.ID_PREFIX + code, { reliable: true });
    conn.on('open', () => conn.send({ t: 'hello', name }));
    conn.on('data', (msg) => {
      if (!msg) return;
      if (msg.t === 'reject') {
        fail(msg.reason === 'full' ? 'Salon plein (5 joueurs max).' : 'La partie a déjà commencé, attends la suivante.');
      } else if (msg.t === 'welcome') {
        done = true;
        clearTimeout(timeout);
        net = { peer, isHost: false, myId: peer.id, conn, leaving: false };
        setMenuBusy(false);
      } else if (msg.t === 'state' && net && net.conn === conn) {
        onState(msg);
      }
    });
    conn.on('close', () => {
      if (net && net.conn === conn && !net.leaving) leave("L'hôte a quitté le salon ou la connexion a été perdue.");
    });
  });

  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') return fail('Salon introuvable. Vérifie le code.');
    if (!done) return fail('Erreur de connexion (' + err.type + ').');
    console.warn('PeerJS', err);
  });
}

function startSolo(name) {
  net = { peer: null, isHost: true, myId: 'solo', conn: null, leaving: false };
  host = createHostState(true);
  hostAddPlayer('solo', name);
  host.timer = setInterval(hostTick, 16);
  hostStartGame();
}

function leave(message) {
  if (net) {
    net.leaving = true;
    if (host) clearInterval(host.timer);
    if (net.peer) net.peer.destroy();
  }
  net = null;
  host = null;
  view = null;
  clockOffset = null;
  currentPhase = null;
  smooth.clear();
  showScreen('screen-menu');
  menuError(message || '');
}

// Réception de l'état (chez tout le monde, hôte compris)
function onState(msg) {
  view = msg;
  const offset = msg.now - now();
  clockOffset = clockOffset === null ? offset : clockOffset * 0.9 + offset * 0.1;
  if (msg.phase !== currentPhase) {
    currentPhase = msg.phase;
    onPhaseChange(msg.phase);
  }
  if (msg.phase === 'lobby') renderLobby();
}

// =============================================================
//  4. INTERFACE (menus)
// =============================================================
const SCREENS = ['screen-blocked', 'screen-menu', 'screen-lobby', 'screen-over'];

function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
}

function menuError(text) { $('menu-error').textContent = text; }

function setMenuBusy(busy, text = '') {
  for (const id of ['btn-create', 'btn-join', 'btn-solo']) $(id).disabled = busy;
  $('menu-status').textContent = busy ? text : '';
  if (busy) menuError('');
}

function onPhaseChange(phase) {
  smooth.clear();
  if (phase === 'lobby') { lastLobbySig = ''; showScreen('screen-lobby'); }
  else if (phase === 'over') { renderOver(); showScreen('screen-over'); }
  else showScreen(null);
}

function playerItem(p, tagText) {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = p.color;
  const name = document.createElement('span');
  name.textContent = p.name;
  li.append(dot, name);
  if (tagText) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = tagText;
    li.append(tag);
  }
  return li;
}

let lastLobbySig = '';
function renderLobby() {
  const sig = view.code + '|' + view.players.map((p) => p.id + p.name).join(',') + '|' + (net && net.isHost);
  if (sig === lastLobbySig) return;
  lastLobbySig = sig;

  $('lobby-code').textContent = view.code;
  const list = $('lobby-players');
  list.innerHTML = '';
  view.players.forEach((p, i) => {
    const tags = [];
    if (i === 0) tags.push('hôte');
    if (net && p.id === net.myId) tags.push('toi');
    list.append(playerItem(p, tags.join(' · ')));
  });

  const isHost = !!(net && net.isHost);
  $('btn-start').classList.toggle('hidden', !isHost);
  $('btn-start').disabled = view.players.length < 2;
  $('btn-start').textContent = view.players.length < 2 ? 'Il faut au moins 2 joueurs' : 'Lancer la partie';
  $('lobby-wait').classList.toggle('hidden', isHost);
}

function renderOver() {
  const title = $('over-title');
  const me2 = view.players.find((p) => net && p.id === net.myId);
  if (view.solo) {
    title.textContent = 'Tu as tenu ' + ((me2 ? me2.survived : 0) / 1000).toFixed(1) + ' s';
  } else if (view.winner) {
    const w = view.players.find((p) => p.id === view.winner);
    title.textContent = w ? (w.id === net.myId ? 'Tu as gagné !' : w.name + ' gagne !') : 'Fin de partie';
  } else {
    title.textContent = 'Égalité !';
  }

  const list = $('over-list');
  list.innerHTML = '';
  [...view.players]
    .sort((a, b) => (b.id === view.winner) - (a.id === view.winner) || b.survived - a.survived)
    .forEach((p) => {
      const label = p.id === view.winner ? 'vainqueur' : (p.survived / 1000).toFixed(1) + ' s';
      list.append(playerItem(p, label));
    });

  const isHost = !!(net && net.isHost);
  $('btn-again').classList.toggle('hidden', !isHost);
  $('over-wait').classList.toggle('hidden', isHost);
}

// =============================================================
//  5. SOURIS
// =============================================================
const canvas = $('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1, scale = 1, offX = 0, offY = 0;

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  scale = (Math.min(W, H) * 0.92) / CFG.ARENA;
  offX = (W - CFG.ARENA * scale) / 2;
  offY = (H - CFG.ARENA * scale) / 2;
}

window.addEventListener('resize', resize);
window.addEventListener('mousemove', (e) => {
  me.x = (e.clientX - offX) / scale;
  me.y = (e.clientY - offY) / scale;
  me.inside = true;
  me.dirty = true;
});
// Sortir la souris de la fenêtre ou changer de fenêtre = sortir du cercle
document.documentElement.addEventListener('mouseleave', () => { me.inside = false; me.dirty = true; });
window.addEventListener('blur', () => { me.inside = false; me.dirty = true; });

function pushMyMouse() {
  if (!net) return;
  if (net.isHost) {
    const p = host && host.players.get(net.myId);
    if (p) { p.x = me.x; p.y = me.y; p.inside = me.inside; }
    return;
  }
  const t = now();
  if (me.dirty && t - me.lastSent >= CFG.MOUSE_RATE && net.conn && net.conn.open) {
    net.conn.send({ t: 'mouse', x: Math.round(me.x), y: Math.round(me.y), inside: me.inside });
    me.dirty = false;
    me.lastSent = t;
  }
}

// =============================================================
//  6. DESSIN
// =============================================================
function frame() {
  requestAnimationFrame(frame);
  pushMyMouse();
  draw();
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0d0f14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const inGame = view && view.circle && view.phase !== 'lobby';
  const myState = inGame && net ? view.players.find((p) => p.id === net.myId) : null;
  canvas.classList.toggle('hide-cursor', !!(myState && myState.alive && view.phase !== 'over'));
  if (!inGame) return;

  const t = now() + clockOffset;

  // Dessin dans le repère de l'arène (0..1000)
  ctx.setTransform(DPR * scale, 0, 0, DPR * scale, DPR * offX, DPR * offY);
  drawCircle(t);
  drawBombs(t);
  drawLasers(t);
  drawPlayers();

  // Dessin en pixels écran (textes)
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawHud(t, myState);
}

function drawCircle(t) {
  const c = view.circle;
  const r = circleRadius(c, t);
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#161a24';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#ff3b3b';
  ctx.shadowColor = '#ff3b3b';
  ctx.shadowBlur = 20;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawLasers(t) {
  const L = CFG.LASER_LEN, w = CFG.LASER_W;
  for (const l of view.lasers) {
    const age = t - l.born;
    if (age < 0) continue;
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.a);

    if (age < CFG.LASER_WARN) {
      // Avertissement : rectangle qui clignote
      const blink = CFG.LASER_WARN / (CFG.LASER_BLINKS * 2);
      if (Math.floor(age / blink) % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 50, 50, 0.18)';
        ctx.fillRect(-L / 2, -w / 2, L, w);
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(-L / 2, -w / 2, L, w);
      }
    } else {
      // Tir : le laser traverse l'écran d'un bout à l'autre
      const fa = age - CFG.LASER_WARN;
      const len = Math.min(1, fa / CFG.LASER_SWEEP) * L;
      const fade = fa > CFG.LASER_SWEEP ? 1 - (fa - CFG.LASER_SWEEP) / CFG.LASER_HOLD : 1;
      ctx.globalAlpha = Math.max(0, fade);
      ctx.shadowColor = '#ff2a2a';
      ctx.shadowBlur = 25;
      ctx.fillStyle = '#ff2a2a';
      ctx.fillRect(-L / 2, -w / 2, len, w);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffe3e3';
      ctx.fillRect(-L / 2, -w / 6, len, w / 3);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

function drawBombs(t) {
  for (const b of view.bombs) {
    const age = t - b.born;
    if (age < 0) continue;
    if (age < CFG.BOMB_FUSE) {
      const k = age / CFG.BOMB_FUSE;
      // Zone d'explosion
      ctx.beginPath();
      ctx.arc(b.x, b.y, CFG.BOMB_R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 140, 0, ${0.08 + 0.15 * k})`;
      ctx.fill();
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = 'rgba(255, 160, 0, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      // Anneau qui se resserre = temps restant
      ctx.beginPath();
      ctx.arc(b.x, b.y, CFG.BOMB_R * (1 - k), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 210, 0, 0.9)';
      ctx.stroke();
      // La bombe
      ctx.beginPath();
      ctx.arc(b.x, b.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = Math.floor(age / 120) % 2 ? '#ff3b3b' : '#2a2a2a';
      ctx.fill();
    } else {
      // Explosion
      const k = Math.min(1, (age - CFG.BOMB_FUSE) / CFG.BOMB_FLASH);
      ctx.beginPath();
      ctx.arc(b.x, b.y, CFG.BOMB_R * (0.7 + 0.3 * k), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 180, 50, ${1 - k})`;
      ctx.fill();
    }
  }
}

function drawPlayers() {
  ctx.font = '600 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (const p of view.players) {
    if (p.gone && !p.alive) continue;
    const isMe = net && p.id === net.myId;
    let x, y;
    if (isMe && p.alive) {
      x = me.x; y = me.y; // ma souris : position exacte, sans délai
    } else {
      const s = smooth.get(p.id) || { x: p.x, y: p.y };
      s.x += (p.x - s.x) * 0.35;
      s.y += (p.y - s.y) * 0.35;
      smooth.set(p.id, s);
      x = s.x; y = s.y;
    }

    if (p.alive) {
      ctx.beginPath();
      ctx.arc(x, y, CFG.CURSOR_R + 2, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
      if (isMe) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
      ctx.fillStyle = '#e8ecf3';
      ctx.fillText(isMe ? p.name + ' (toi)' : p.name, x, y - 18);
    } else {
      ctx.strokeStyle = '#5b6273';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 8); ctx.lineTo(x + 8, y + 8);
      ctx.moveTo(x + 8, y - 8); ctx.lineTo(x - 8, y + 8);
      ctx.stroke();
      ctx.fillStyle = '#5b6273';
      ctx.fillText(p.name, x, y - 16);
    }
  }
}

function drawHud(t, myState) {
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e8ecf3';

  if (view.phase === 'countdown') {
    const n = Math.max(1, Math.ceil((view.t0 - t) / 1000));
    ctx.textAlign = 'center';
    ctx.font = '800 96px system-ui, sans-serif';
    ctx.fillText(String(n), W / 2, H / 2 + 32);
    ctx.font = '600 20px system-ui, sans-serif';
    ctx.fillStyle = '#ffd54f';
    ctx.fillText('Place ta souris dans le cercle !', W / 2, H / 2 + 80);
    return;
  }

  const elapsed = Math.max(0, ((view.phase === 'over' ? view.endTime : t) - view.t0) / 1000);
  const alive = view.players.filter((p) => p.alive).length;
  const nextIn = Math.max(0, Math.ceil((view.nextShrink - t) / 1000));

  ctx.font = '600 16px system-ui, sans-serif';
  ctx.fillText('Temps : ' + elapsed.toFixed(1) + ' s', 16, 28);
  ctx.fillText('Rétrécissement ' + view.shrinks + ' — prochain dans ' + nextIn + ' s', 16, 50);
  if (!view.solo) ctx.fillText('En vie : ' + alive + ' / ' + view.players.filter((p) => !p.gone).length, 16, 72);

  ctx.fillStyle = view.shrinks >= CFG.BOMB_FROM_SHRINK ? '#ffb74d' : '#8a93a6';
  const left = CFG.BOMB_FROM_SHRINK - view.shrinks;
  ctx.fillText(left > 0 ? 'Bombes dans ' + left + ' rétrécissement(s)' : 'Bombes actives !', 16, view.solo ? 72 : 94);

  if (myState && !myState.alive && view.phase === 'playing') {
    ctx.textAlign = 'center';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillStyle = '#ff6b6b';
    ctx.fillText('Éliminé : ' + (CAUSES[myState.cause] || '') + ' — tu regardes la partie', W / 2, 40);
  }
}

// =============================================================
//  7. DÉMARRAGE
// =============================================================
(async function init() {
  resize();
  requestAnimationFrame(frame);

  const ok = await acquireTabLock();
  if (!ok) { showScreen('screen-blocked'); return; }

  // Pseudo mémorisé
  try { $('input-name').value = localStorage.getItem('mousseover-name') || ''; } catch (e) { /* rien */ }
  const getName = () => {
    const n = cleanName($('input-name').value);
    try { localStorage.setItem('mousseover-name', n); } catch (e) { /* rien */ }
    return n;
  };

  // Lien d'invitation : https://.../#ABCD
  const hashCode = location.hash.replace('#', '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(hashCode)) $('input-code').value = hashCode;

  $('input-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  const tryJoin = () => {
    const code = $('input-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { menuError('Le code fait 4 caractères.'); return; }
    joinRoom(getName(), code);
  };

  $('btn-create').addEventListener('click', () => startHosting(getName()));
  $('btn-join').addEventListener('click', tryJoin);
  $('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });
  $('btn-solo').addEventListener('click', () => startSolo(getName()));

  $('btn-start').addEventListener('click', () => {
    if (host && host.phase === 'lobby' && host.players.size >= 2) hostStartGame();
  });
  $('btn-again').addEventListener('click', () => {
    if (!host) return;
    if (host.solo) hostStartGame(); else hostBackToLobby();
  });
  $('btn-copy').addEventListener('click', async () => {
    if (!view) return;
    const url = location.origin + location.pathname + '#' + view.code;
    try {
      await navigator.clipboard.writeText(url);
      $('btn-copy').textContent = 'Lien copié !';
    } catch (e) {
      $('btn-copy').textContent = url;
    }
    setTimeout(() => { $('btn-copy').textContent = "Copier le lien d'invitation"; }, 2000);
  });
  $('btn-leave').addEventListener('click', () => leave());
  $('btn-over-leave').addEventListener('click', () => leave());

  showScreen('screen-menu');
})();
