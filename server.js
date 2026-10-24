const http = require('http'), fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const D = process.env.DATA_DIR || '/data', PORT = process.env.PORT || 8080;
const PW = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
if (!process.env.ADMIN_PASSWORD) console.log('ADMIN_PASSWORD is not set. Temporary password:', PW);
fs.mkdirSync(D, { recursive: true });

const VERS = ['1.16.5', '1.20.1', '1.21.10'], TYPES = ['PAPER', 'VANILLA', 'FORGE', 'FABRIC'];
const CF = D + '/panel.json', PF = D + '/server.properties', WF = D + '/whitelist.json';
let cfg = { type: 'PAPER', version: '1.20.1', memory: '2G', domain: '', installed: null };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CF)) }; } catch {}
const save = () => fs.writeFileSync(CF, JSON.stringify(cfg, null, 1));
let proc = null, busy = false, logs = [], seq = 0;
const log = s => String(s).split(/\r?\n/).forEach(l => { if (l) { logs.push(l); seq++; if (logs.length > 800) logs.shift(); } });

const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const TOK = hash(PW + ':mc-panel');
const body = q => new Promise(r => { let d = ''; q.on('data', c => d += c); q.on('end', () => r(d)); });
const minor = () => +cfg.version.split('.')[1];
const dirOf = () => cfg.type === 'PAPER' ? 'plugins' : cfg.type === 'VANILLA' ? null : 'mods';
const javaHome = () => minor() <= 16 ? '/opt/java8' : minor() <= 20 ? '/opt/java17' : '/opt/java21';

// ---------- server.properties ----------
const PD = { motd: 'A Minecraft Server', 'server-port': '25565', 'max-players': '10', gamemode: 'survival', difficulty: 'easy', 'level-type': 'default', 'level-seed': '', 'online-mode': 'true', 'white-list': 'false', pvp: 'true' };
const LT = { default: 'normal', flat: 'flat', largebiomes: 'large_biomes', amplified: 'amplified' };
const rawProps = () => {
  const o = {};
  if (fs.existsSync(PF)) for (const l of fs.readFileSync(PF, 'utf8').split(/\r?\n/)) { const i = l.indexOf('='); if (i > 0 && l[0] !== '#') o[l.slice(0, i)] = l.slice(i + 1); }
  return o;
};
const getProps = () => {
  const o = { ...PD, ...rawProps() };
  o['level-type'] = o['level-type'].replace('minecraft:', '').replace('normal', 'default').replace('large_biomes', 'largebiomes');
  return o;
};
function setProps(p) {
  const o = {};
  for (const k in p) o[k] = String(p[k]).replace(/[\r\n]/g, '');
  if ('white-list' in o) o['enforce-whitelist'] = o['white-list'];
  if (o['level-type']) o['level-type'] = minor() >= 19 ? 'minecraft:' + (LT[o['level-type']] || 'normal') : o['level-type'];
  let t = fs.existsSync(PF) ? fs.readFileSync(PF, 'utf8') : '';
  const seen = new Set();
  t = t.split(/\r?\n/).map(l => { const i = l.indexOf('='), k = l.slice(0, i); if (i > 0 && k in o) { seen.add(k); return k + '=' + o[k]; } return l; }).join('\n');
  for (const k in o) if (!seen.has(k)) t += (t && !t.endsWith('\n') ? '\n' : '') + k + '=' + o[k] + '\n';
  fs.writeFileSync(PF, t);
}

// ---------- install / start / stop ----------
const jget = u => fetch(u, { headers: { 'user-agent': 'mc-panel' } }).then(r => { if (!r.ok) throw new Error(u + ' -> ' + r.status); return r.json(); });
const dl = async (u, f) => { const r = await fetch(u, { headers: { 'user-agent': 'mc-panel' } }); if (!r.ok) throw new Error('download ' + r.status); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); };
const run = (c, args) => new Promise((ok, no) => { const p = cp.spawn(c, args, { cwd: D }); p.stdout.on('data', log); p.stderr.on('data', log); p.on('exit', x => x ? no(new Error('exit ' + x)) : ok()); });

async function install() {
  const { type, version: v } = cfg;
  log(`[panel] Installing ${type} ${v} ...`);
  for (const f of fs.readdirSync(D)) if (/^(server\.jar|forge-.*\.jar|minecraft_server.*\.jar|libraries|run\.(sh|bat)|user_jvm_args\.txt|installer\.jar.*|\.fabric)$/.test(f)) fs.rmSync(D + '/' + f, { recursive: true, force: true });
  if (type === 'PAPER') {
    let url;
    try { const b = await jget(`https://fill.papermc.io/v3/projects/paper/versions/${v}/builds/latest`); url = b.downloads['server:default'].url; }
    catch { const b = (await jget(`https://api.papermc.io/v2/projects/paper/versions/${v}/builds`)).builds.pop(); url = `https://api.papermc.io/v2/projects/paper/versions/${v}/builds/${b.build}/downloads/${b.downloads.application.name}`; }
    await dl(url, D + '/server.jar');
  } else if (type === 'VANILLA') {
    const e = (await jget('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).versions.find(x => x.id === v);
    await dl((await jget(e.url)).downloads.server.url, D + '/server.jar');
  } else if (type === 'FABRIC') {
    const l = (await jget('https://meta.fabricmc.net/v2/versions/loader')).find(x => x.stable).version;
    const i = (await jget('https://meta.fabricmc.net/v2/versions/installer')).find(x => x.stable).version;
    await dl(`https://meta.fabricmc.net/v2/versions/loader/${v}/${l}/${i}/server/jar`, D + '/server.jar');
  } else if (type === 'FORGE') {
    const p = (await jget('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    const fv = p[v + '-recommended'] || p[v + '-latest'];
    if (!fv) throw new Error('Forge is not available for ' + v);
    const fn = `${v}-${fv}`;
    await dl(`https://maven.minecraftforge.net/net/minecraftforge/forge/${fn}/forge-${fn}-installer.jar`, D + '/installer.jar');
    await run(javaHome() + '/bin/java', ['-jar', 'installer.jar', '--installServer']);
    fs.rmSync(D + '/installer.jar', { force: true });
  }
  log('[panel] Install finished.');
}

async function start() {
  if (proc || busy) throw new Error('Server is already running');
  busy = true;
  try {
    const i = cfg.installed;
    if (!i || i.type !== cfg.type || i.version !== cfg.version) { await install(); cfg.installed = { type: cfg.type, version: cfg.version }; save(); }
  } finally { busy = false; }
  fs.writeFileSync(D + '/eula.txt', 'eula=true\n');
  if (!fs.existsSync(PF)) setProps({});
  const a = ['-Xms512M', '-Xmx' + cfg.memory];
  const fj = fs.readdirSync(D).find(f => /^forge-.*\.jar$/.test(f));
  const fd = D + '/libraries/net/minecraftforge/forge';
  if (cfg.type === 'FORGE' && !fj && fs.existsSync(fd)) a.push('@' + fd + '/' + fs.readdirSync(fd)[0] + '/unix_args.txt', 'nogui');
  else a.push('-jar', cfg.type === 'FORGE' && fj ? fj : 'server.jar', 'nogui');
  log('[panel] Starting server ...');
  proc = cp.spawn(javaHome() + '/bin/java', a, { cwd: D });
  proc.stdout.on('data', log); proc.stderr.on('data', log);
  proc.on('exit', c => { log('[panel] Server stopped (code ' + c + ')'); proc = null; });
}
const stop = () => new Promise(r => {
  if (!proc) return r();
  const p = proc; p.once('exit', () => r()); p.stdin.write('stop\n');
  setTimeout(() => p.kill('SIGKILL'), 60000);
});
const wipeWorld = () => ['world', 'world_nether', 'world_the_end'].forEach(w => fs.rmSync(D + '/' + w, { recursive: true, force: true }));

async function setWorld(zip) {
  if (proc) throw new Error('Stop the server first');
  const t = '/tmp/w'; fs.rmSync(t, { recursive: true, force: true }); fs.mkdirSync(t);
  if (cp.spawnSync('unzip', ['-q', '-o', zip, '-d', t]).status) throw new Error('Invalid zip file');
  const find = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'level.dat') return d; if (e.isDirectory()) { const x = find(path.join(d, e.name)); if (x) return x; } } };
  const root = find(t);
  if (!root) throw new Error('level.dat not found inside the zip');
  wipeWorld(); fs.cpSync(root, D + '/world', { recursive: true });
  setProps({ 'level-name': 'world' });
  fs.rmSync(t, { recursive: true, force: true }); fs.rmSync(zip, { force: true });
}

// ---------- whitelist ----------
const wl = () => { try { return JSON.parse(fs.readFileSync(WF)); } catch { return []; } };
const wsave = l => { fs.writeFileSync(WF, JSON.stringify(l, null, 2)); if (proc) proc.stdin.write('whitelist reload\n'); };
const dash = x => x.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
async function uuidOf(n) {
  if (getProps()['online-mode'] !== 'false') {
    const r = await fetch('https://api.mojang.com/users/profiles/minecraft/' + n);
    if (!r.ok) throw new Error('Player not found');
    return dash((await r.json()).id);
  }
  const h = crypto.createHash('md5').update('OfflinePlayer:' + n).digest();
  h[6] = h[6] & 15 | 48; h[8] = h[8] & 63 | 128;
  return dash(h.toString('hex'));
}

// ---------- HTTP ----------
http.createServer(async (q, s) => {
  const u = new URL(q.url, 'http://x'), R = u.pathname;
  const send = (c, o) => { s.writeHead(c, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
  try {
    if (R === '/') { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return s.end(fs.readFileSync(__dirname + '/index.html')); }
    if (R === '/api/login' && q.method === 'POST') {
      const b = JSON.parse(await body(q));
      if (b.password && eq(hash(String(b.password)), hash(PW))) { s.setHeader('set-cookie', `tok=${TOK}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`); return send(200, { ok: 1 }); }
      return send(401, { error: 'Wrong password' });
    }
    const ck = (q.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('tok=')) || '';
    if (!eq(ck.slice(4), TOK)) return send(401, { error: 'auth' });

    if (R === '/api/state') {
      const since = +u.searchParams.get('since') || 0;
      const n = Math.min(logs.length, Math.max(0, since > seq ? seq : seq - since));
      return send(200, { running: !!proc, busy, seq, lines: n ? logs.slice(-n) : [], domain: cfg.domain, port: getProps()['server-port'] });
    }
    if (R === '/api/config' && q.method === 'GET') return send(200, { cfg, props: getProps(), versions: VERS, types: TYPES });
    if (R === '/api/config' && q.method === 'POST') {
      const b = JSON.parse(await body(q));
      if (b.type !== undefined) { if (!TYPES.includes(b.type)) throw new Error('Invalid type'); cfg.type = b.type; }
      if (b.version !== undefined) { if (!VERS.includes(b.version)) throw new Error('Invalid version'); cfg.version = b.version; }
      if (b.memory !== undefined) { if (!/^\d{1,2}[MG]$/i.test(b.memory)) throw new Error('Memory must look like 2G or 1536M'); cfg.memory = b.memory.toUpperCase(); }
      if (b.domain !== undefined) cfg.domain = String(b.domain).trim().replace(/[^\w.:-]/g, '');
      save();
      if (b.props) { const p = {}; for (const k in PD) if (k in b.props) p[k] = b.props[k]; setProps(p); }
      return send(200, { ok: 1 });
    }
    if (R === '/api/start') { start().catch(e => log('[panel] Error: ' + e.message)); return send(200, { ok: 1 }); }
    if (R === '/api/stop') { await stop(); return send(200, { ok: 1 }); }
    if (R === '/api/restart') { stop().then(() => start()).catch(e => log('[panel] Error: ' + e.message)); return send(200, { ok: 1 }); }
    if (R === '/api/cmd' && q.method === 'POST') {
      if (!proc) throw new Error('Server is off');
      proc.stdin.write(String(JSON.parse(await body(q)).cmd).replace(/[\r\n]/g, '') + '\n'); return send(200, { ok: 1 });
    }
    if (R === '/api/world/reset' && q.method === 'POST') { if (proc) throw new Error('Stop the server first'); wipeWorld(); return send(200, { ok: 1 }); }
    if (R === '/api/icon') {
      const f = D + '/server-icon.png';
      if (!fs.existsSync(f)) return send(404, {});
      s.writeHead(200, { 'content-type': 'image/png' }); return s.end(fs.readFileSync(f));
    }
    if (R === '/api/upload' && q.method === 'POST') {
      const k = u.searchParams.get('kind'), n = path.basename(u.searchParams.get('name') || '');
      let dest;
      if (k === 'icon') dest = D + '/server-icon.png';
      else if (k === 'world') { if (proc) throw new Error('Stop the server first'); dest = '/tmp/up.zip'; }
      else if (k === 'plugin') {
        const d = dirOf();
        if (!d) throw new Error('Vanilla has no plugins or mods');
        if (!/\.jar$/i.test(n)) throw new Error('Only .jar files');
        fs.mkdirSync(D + '/' + d, { recursive: true }); dest = D + '/' + d + '/' + n;
      } else throw new Error('Bad upload kind');
      await new Promise((ok, no) => { const w = fs.createWriteStream(dest); q.pipe(w); w.on('finish', ok); w.on('error', no); q.on('error', no); });
      if (k === 'world') await setWorld(dest);
      return send(200, { ok: 1 });
    }
    if (R === '/api/files') {
      const d = dirOf();
      if (q.method === 'DELETE') { if (d) fs.rmSync(D + '/' + d + '/' + path.basename(u.searchParams.get('name') || ''), { force: true }); return send(200, { ok: 1 }); }
      const files = d && fs.existsSync(D + '/' + d) ? fs.readdirSync(D + '/' + d).filter(f => /\.jar$/i.test(f)).map(f => ({ name: f, size: fs.statSync(D + '/' + d + '/' + f).size })) : [];
      return send(200, { dir: d, files });
    }
    if (R === '/api/whitelist') {
      if (q.method === 'GET') return send(200, { list: wl().map(x => x.name) });
      const n = q.method === 'POST' ? String(JSON.parse(await body(q)).name || '') : u.searchParams.get('name') || '';
      if (!/^\w{1,16}$/.test(n)) throw new Error('Invalid username');
      let l = wl();
      if (q.method === 'POST') { if (!l.some(x => x.name.toLowerCase() === n.toLowerCase())) l.push({ uuid: await uuidOf(n), name: n }); }
      else l = l.filter(x => x.name.toLowerCase() !== n.toLowerCase());
      wsave(l); return send(200, { ok: 1 });
    }
    send(404, { error: 'not found' });
  } catch (e) { send(400, { error: e.message }); }
}).listen(PORT, '0.0.0.0', () => console.log('Panel listening on', PORT));
