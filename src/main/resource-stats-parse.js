/**
 * Readers for what a Linux host says about itself: the text behind the
 * resource bar under each SSH pane.
 *
 * Kept free of Electron and SSH so every format can be tested against fixture
 * output. The collector (resource-stats.js) runs one script per tick and hands
 * its stdout here in `@@name`-delimited sections.
 */

/** Splits the script's output on its `@@name` marker lines. */
function splitSections(stdout) {
    const sections = {};
    let current = null;
    for (const line of String(stdout || '').split('\n')) {
        const marker = /^@@([a-z]+)\s*$/.exec(line);
        if (marker) {
            current = marker[1];
            sections[current] = [];
        } else if (current) {
            sections[current].push(line);
        }
    }
    const joined = {};
    for (const [name, lines] of Object.entries(sections)) {
        joined[name] = lines.join('\n').trim();
    }
    return joined;
}

/**
 * The aggregate `cpu` line of /proc/stat, as jiffies.
 *
 * iowait counts as idle: the CPU is free for other work while it waits, and
 * that is how top and MobaXterm both report it.
 */
function parseCpu(text) {
    const line = String(text || '').split('\n').find(row => /^cpu\s/.test(row));
    if (!line) return null;
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 4 || fields.some(n => !Number.isFinite(n))) return null;

    // guest and guest_nice are already counted inside user and nice.
    const counted = fields.slice(0, 8);
    const total = counted.reduce((sum, n) => sum + n, 0);
    const idle = (fields[3] || 0) + (fields[4] || 0);
    return { total, idle };
}

/** /proc/meminfo, in bytes. */
function parseMeminfo(text) {
    const kb = {};
    for (const line of String(text || '').split('\n')) {
        const match = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
        if (match) kb[match[1]] = Number(match[2]);
    }
    if (!kb.MemTotal) return null;

    const buffers = kb.Buffers || 0;
    // SReclaimable is cache in all but name, and `free` counts it as such.
    const cached = (kb.Cached || 0) + (kb.SReclaimable || 0);
    // Kernels before 3.14 have no MemAvailable. Free plus what can be dropped
    // is the estimate `free` itself used before it existed.
    const available = kb.MemAvailable ?? ((kb.MemFree || 0) + buffers + cached);

    const bytes = n => n * 1024;
    return {
        total: bytes(kb.MemTotal),
        used: bytes(Math.max(0, kb.MemTotal - available)),
        available: bytes(available),
        free: bytes(kb.MemFree || 0),
        cached: bytes(cached),
        buffers: bytes(buffers),
        swapTotal: bytes(kb.SwapTotal || 0),
        swapFree: bytes(kb.SwapFree || 0),
    };
}

/** /proc/net/dev: cumulative bytes per interface, loopback left out. */
function parseNetDev(text) {
    const interfaces = [];
    for (const line of String(text || '').split('\n')) {
        const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
        if (!match) continue;
        const iface = match[1];
        if (iface === 'lo') continue;
        const fields = match[2].trim().split(/\s+/).map(Number);
        if (fields.length < 9) continue;
        interfaces.push({ iface, rx: fields[0], tx: fields[8] });
    }
    return interfaces;
}

/** /proc/uptime and /proc/loadavg. */
function parseUptime(uptimeText, loadText) {
    // parseFloat, not Number: an empty section must read as missing, not 0.
    const seconds = parseFloat(String(uptimeText || '').trim().split(/\s+/)[0]);
    const load = String(loadText || '').trim().split(/\s+/).slice(0, 3).map(parseFloat);
    return {
        seconds: Number.isFinite(seconds) ? Math.floor(seconds) : null,
        load: load.length === 3 && load.every(Number.isFinite) ? load : null,
    };
}

/**
 * `who`, one row per login.
 *
 *   gp       pts/0        2026-09-29 10:12 (192.168.1.5)
 *   root     tty1         Sep 29 10:12
 */
function parseWho(text) {
    const users = [];
    for (const raw of String(text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const match = /^(\S+)\s+(\S+)\s+(.*?)\s*(?:\(([^)]*)\))?$/.exec(line);
        if (!match) continue;
        users.push({
            user: match[1],
            tty: match[2],
            when: match[3].trim(),
            from: (match[4] || '').trim(),
        });
    }
    return users;
}

/**
 * Filesystems that are not storage: memory-backed, kernel interfaces, and
 * read-only images. Counting them would put a dozen 0%-used tmpfs mounts and
 * a row of 100%-full snaps beside the disks that matter.
 */
const PSEUDO_FS = new Set([
    'tmpfs', 'devtmpfs', 'devfs', 'overlay', 'squashfs', 'proc', 'sysfs', 'udev',
    'none', 'shm', 'run', 'ramfs', 'rootfs', 'efivarfs', 'securityfs', 'pstore',
    'debugfs', 'tracefs', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs', 'bpf',
    'autofs', 'binfmt_misc', 'nsfs', 'devpts', 'cgroup', 'cgroup2', 'fuse.lxcfs',
    'fuse.gvfsd-fuse', 'fuse.portal', 'fuse.snapfuse',
]);

/**
 * `df -PTk` or, where -T is not understood (busybox), `df -Pk`. Sizes come
 * back in bytes.
 *
 * Mount points may contain spaces, so a row is read from the capacity column
 * outwards rather than split on whitespace.
 */
function parseDf(text) {
    const lines = String(text || '').split('\n').filter(line => line.trim());
    if (lines.length === 0) return [];

    const typed = /\bType\b/.test(lines[0]);
    const body = /^Filesystem/i.test(lines[0]) ? lines.slice(1) : lines;

    const disks = [];
    const seen = new Set();
    for (const line of body) {
        const tokens = line.trim().split(/\s+/);
        const capacityIndex = tokens.findIndex((token, index) => index >= (typed ? 5 : 4) && /^(\d+%|-)$/.test(token));
        if (capacityIndex < 0) continue;

        const fs = tokens.slice(0, capacityIndex - (typed ? 4 : 3)).join(' ');
        const type = typed ? tokens[capacityIndex - 4] : '';
        const [size, used, avail] = tokens.slice(capacityIndex - 3, capacityIndex).map(Number);
        const mount = tokens.slice(capacityIndex + 1).join(' ');

        if (![size, used, avail].every(Number.isFinite) || size <= 0 || !mount) continue;
        if (PSEUDO_FS.has(type) || type.startsWith('cgroup') || PSEUDO_FS.has(fs)) continue;
        // Untyped output cannot name a snap's squashfs, but its mount can.
        if (mount.startsWith('/snap/') || mount === '/dev' || mount.startsWith('/sys') || mount.startsWith('/proc')) continue;
        // Bind mounts show the same device twice; the first is the real one.
        if (seen.has(fs)) continue;
        seen.add(fs);

        // df's own figure where it gave one, so the bar agrees with `df`: it
        // measures against what a user can write, which excludes the blocks
        // reserved for root.
        const capacity = tokens[capacityIndex];
        const pct = capacity.endsWith('%')
            ? Number(capacity.slice(0, -1))
            : Math.round((used / (used + avail || size)) * 100);
        disks.push({ fs, type, size: size * 1024, used: used * 1024, avail: avail * 1024, pct, mount });
    }
    return disks;
}

/**
 * Turns two sets of cumulative counters into rates.
 *
 * Returns null for the first sample, which has nothing to compare against. A
 * counter that went down (a reboot the connection survived, an interface that
 * was recreated, a 32-bit wrap) reads as zero rather than as a huge negative.
 */
function computeRates(prev, cur, dtMs) {
    if (!prev || !cur || !(dtMs > 0)) return null;
    const seconds = dtMs / 1000;

    let cpu = null;
    if (prev.cpu && cur.cpu) {
        const total = cur.cpu.total - prev.cpu.total;
        const idle = cur.cpu.idle - prev.cpu.idle;
        if (total > 0 && idle >= 0) {
            cpu = Math.min(100, Math.max(0, ((total - idle) / total) * 100));
        } else {
            cpu = 0;
        }
    }

    const before = new Map((prev.net || []).map(entry => [entry.iface, entry]));
    const ifaces = [];
    let up = 0;
    let down = 0;
    for (const entry of cur.net || []) {
        const last = before.get(entry.iface);
        if (!last) continue;
        const rx = Math.max(0, entry.rx - last.rx) / seconds;
        const tx = Math.max(0, entry.tx - last.tx) / seconds;
        ifaces.push({ iface: entry.iface, up: tx, down: rx });
        up += tx;
        down += rx;
    }

    return { cpu, net: { up, down, ifaces } };
}

module.exports = {
    splitSections,
    parseCpu,
    parseMeminfo,
    parseNetDev,
    parseUptime,
    parseWho,
    parseDf,
    computeRates,
    PSEUDO_FS,
};
