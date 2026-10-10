/* Shared helpers usable from both the shell (extension.js) and prefs.js.
 * Only GLib/Gio may be used here. */
'use strict';

const { GLib, Gio } = imports.gi;

const decoder = new TextDecoder('utf-8');

var INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600];

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch (e) {
        return null;
    }
}

function listDir(path) {
    const names = [];
    try {
        const en = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null)
            names.push(info.get_name());
        en.close(null);
    } catch (e) {
        // directory missing or unreadable
    }
    return names;
}

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/* ---------- /proc readers ---------- */

/* Returns { user, nice, system, idle, iowait, total } jiffies from the
 * aggregate "cpu" line. irq/softirq/steal are counted as system time. */
function readCpu() {
    const txt = readFile('/proc/stat');
    if (!txt)
        return null;
    const f = txt.split('\n', 1)[0].trim().split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
    // guest/guest_nice are already included in user/nice
    const sys = system + irq + softirq + steal;
    return {
        user, nice, system: sys, idle, iowait,
        total: user + nice + sys + idle + iowait,
    };
}

/* Returns kB values from /proc/meminfo. */
function readMeminfo() {
    const txt = readFile('/proc/meminfo');
    const m = {};
    if (!txt)
        return m;
    for (const line of txt.split('\n')) {
        const match = line.match(/^(\w+):\s+(\d+)/);
        if (match)
            m[match[1]] = Number(match[2]);
    }
    return m;
}

const VIRTUAL_IFACE = /^(lo|veth|docker|br-|virbr|vnet|tun|tap|wg|zt|tailscale)/;

/* Sum rx/tx byte counters of all physical interfaces. */
function readNet() {
    const txt = readFile('/proc/net/dev');
    if (!txt)
        return null;
    let rx = 0, tx = 0;
    for (const line of txt.split('\n').slice(2)) {
        const idx = line.indexOf(':');
        if (idx < 0)
            continue;
        const iface = line.slice(0, idx).trim();
        if (VIRTUAL_IFACE.test(iface))
            continue;
        const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
        rx += f[0];
        tx += f[8];
    }
    return { rx, tx };
}

/* ---------- temperature sensors ---------- */

/* List all hwmon temperature inputs.
 * Each sensor: { id: 'name/label', title: 'name: label', path }.
 * The id is stable across reboots, unlike the hwmonN number. */
function listTempSensors() {
    const base = '/sys/class/hwmon';
    const sensors = [];
    const seen = new Map();
    for (const hw of listDir(base).sort(naturalCompare)) {
        const dir = `${base}/${hw}`;
        const name = (readFile(`${dir}/name`) || hw).trim();
        const inputs = listDir(dir)
            .filter(n => /^temp\d+_input$/.test(n))
            .sort(naturalCompare);
        for (const input of inputs) {
            const prefix = input.replace('_input', '');
            const label = (readFile(`${dir}/${prefix}_label`) || prefix).trim();
            let id = `${name}/${label}`;
            const count = (seen.get(id) || 0) + 1;
            seen.set(id, count);
            if (count > 1)
                id += ` #${count}`;
            sensors.push({ id, title: `${name}: ${label}${count > 1 ? ` #${count}` : ''}`, path: `${dir}/${input}` });
        }
    }
    return sensors;
}

const PREFERRED_SENSORS = [
    /^coretemp\/Package id 0$/,
    /^k10temp\/Tctl$/,
    /^k10temp\/Tdie$/,
    /^zenpower\/Tdie$/,
    /^coretemp\//,
    /^k10temp\//,
    /^cpu_thermal\//,
    /^acpitz\//,
];

/* Resolve a sensor id to a sysfs path. Empty id or unknown id falls back
 * to the best CPU-looking sensor. */
function resolveTempSensor(id) {
    const sensors = listTempSensors();
    if (id) {
        const s = sensors.find(x => x.id === id);
        if (s)
            return s;
    }
    for (const re of PREFERRED_SENSORS) {
        const s = sensors.find(x => re.test(x.id));
        if (s)
            return s;
    }
    return sensors[0] || null;
}

/* Returns degrees Celsius or null. */
function readTemp(path) {
    const txt = readFile(path);
    if (txt === null)
        return null;
    const v = Number(txt.trim());
    return Number.isFinite(v) ? v / 1000 : null;
}

/* ---------- mounts ---------- */

const REAL_FS = new Set([
    'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'jfs', 'reiserfs', 'zfs',
    'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'hfsplus', 'ecryptfs',
    'nfs', 'nfs4', 'cifs', 'smb3', 'bcachefs', 'nilfs2',
]);

const unescapeMount = s => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

/* List user-relevant mounted filesystems: [{ mount, device, fstype }]. */
function listMounts() {
    const txt = readFile('/proc/mounts') || '';
    const out = [];
    const seen = new Set();
    for (const line of txt.split('\n')) {
        const [dev, mnt, fstype] = line.split(' ');
        if (!mnt || !REAL_FS.has(fstype))
            continue;
        const mount = unescapeMount(mnt);
        if (/^\/(snap|var\/snap|run|proc|sys|dev)(\/|$)/.test(mount) || seen.has(mount))
            continue;
        seen.add(mount);
        out.push({ mount, device: unescapeMount(dev), fstype });
    }
    return out.sort((a, b) => naturalCompare(a.mount, b.mount));
}

/* ---------- formatting / colors ---------- */

function formatBytes(bytes, suffix = '') {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let i = 0;
    while (bytes >= 1000 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    const n = bytes < 10 && i > 0 ? bytes.toFixed(1) : Math.round(bytes).toString();
    return `${n}${units[i]}${suffix}`;
}

function formatInterval(s) {
    if (s < 60)
        return `${s} s/px`;
    return `${s / 60} min/px`;
}

/* Parse '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(r,g,b)' or 'rgba(r,g,b,a)'
 * into [r, g, b, a] with components in 0..1. */
function parseColor(str, fallback = [1, 1, 1, 1]) {
    if (!str)
        return fallback;
    str = str.trim();
    let m = str.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (m)
        return [m[1] / 255, m[2] / 255, m[3] / 255, m[4] !== undefined ? Number(m[4]) : 1];
    m = str.match(/^#([0-9a-f]+)$/i);
    if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4)
            h = [...h].map(c => c + c).join('');
        if (h.length === 6)
            h += 'ff';
        if (h.length === 8) {
            const n = [0, 2, 4, 6].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
            return n;
        }
    }
    return fallback;
}
