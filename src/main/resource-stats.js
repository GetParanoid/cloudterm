const ssh = require('./ssh');
const exec = require('./ai/exec');
const {
    splitSections,
    parseCpu,
    parseMeminfo,
    parseNetDev,
    parseUptime,
    parseWho,
    parseDf,
    computeRates,
} = require('./resource-stats-parse');

/**
 * The numbers behind the resource bar under each SSH pane: CPU, memory,
 * network, uptime, who is logged in, and disk use.
 *
 * One exec channel per sample, running one script that prints everything, so a
 * tick costs the server a single short-lived channel rather than one per
 * figure. It is the same kind of channel the assistant runs commands on (see
 * ai/exec.js), so the shell the user is typing into never sees it.
 *
 * The renderer decides when to ask, which is only while the pane is on screen.
 * This side only remembers the previous counters, because CPU use and network
 * speed are both differences between two readings.
 */

/** Long enough for a loaded server, short of the next tick piling up behind it. */
const SAMPLE_TIMEOUT = 8000;

/*
 * Run under `sh` explicitly: exec goes through the account's login shell, which
 * may be fish or csh. One line, because csh will not take a newline inside a
 * quoted argument. `df` is bounded because a hung NFS mount blocks it
 * forever, and read into a variable because it exits non-zero whenever any one
 * mount is unreadable, even after printing all the others.
 */
const SAMPLE_SCRIPT = [
    'export LC_ALL=C',
    'echo @@stat; head -n 1 /proc/stat 2>/dev/null',
    'echo @@mem; cat /proc/meminfo 2>/dev/null',
    'echo @@net; cat /proc/net/dev 2>/dev/null',
    'echo @@uptime; cat /proc/uptime 2>/dev/null',
    'echo @@load; cat /proc/loadavg 2>/dev/null',
    'echo @@who; who 2>/dev/null',
    'if command -v timeout >/dev/null 2>&1; then T="timeout 2"; else T=""; fi',
    'D=$($T df -PTk 2>/dev/null); [ -n "$D" ] || D=$($T df -Pk 2>/dev/null)',
    'echo @@df; printf "%s\\n" "$D"',
].join('; ');

/** What does not change for the life of a connection, asked for once. */
const IDENTITY_SCRIPT = [
    'echo @@host; hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null',
    'echo @@kernel; uname -srm 2>/dev/null',
    'echo @@os; sed -n "s/^PRETTY_NAME=//p" /etc/os-release 2>/dev/null | tr -d \\"',
].join('; ');

// tabId -> { client, prev, prevAt, identity }
const byTab = new Map();

/**
 * The state for a pane's *current* connection. A reconnect reuses the pane id
 * but brings a new client, and counters from the old one would compare a
 * server's uptime against itself before a reboot.
 */
function entryFor(tabId, client) {
    let entry = byTab.get(tabId);
    if (!entry || entry.client !== client) {
        entry = { client, prev: null, prevAt: 0, identity: null };
        byTab.set(tabId, entry);
    }
    return entry;
}

async function sample(tabId) {
    const session = ssh.sessions.get(tabId);
    if (!session?.client) {
        return { success: false, message: 'That session is not an open SSH connection' };
    }
    const entry = entryFor(tabId, session.client);

    const script = entry.identity ? SAMPLE_SCRIPT : `${IDENTITY_SCRIPT}; ${SAMPLE_SCRIPT}`;
    const result = await exec.run(tabId, `sh -c ${exec.shellQuote(script)}`, { timeout: SAMPLE_TIMEOUT });
    if (!result.success) return { success: false, message: result.message || 'The sample failed' };

    // The connection may have been replaced while the command ran.
    if (byTab.get(tabId) !== entry) return { success: false, message: 'The session was replaced' };

    const sections = splitSections(result.stdout);
    if (!entry.identity) {
        entry.identity = {
            name: sections.host || '',
            kernel: sections.kernel || '',
            os: sections.os || '',
        };
    }

    const cpu = parseCpu(sections.stat);
    // Everything here reads /proc. A BSD, a Mac, or a Windows shell that
    // ignored the script entirely has none of it.
    if (!cpu) return { success: true, supported: false, host: entry.identity };

    const net = parseNetDev(sections.net);
    const now = Date.now();
    const rates = computeRates(entry.prev, { cpu, net }, now - entry.prevAt);
    entry.prev = { cpu, net };
    entry.prevAt = now;

    const disks = parseDf(sections.df);
    const diskTotal = disks.reduce(
        (sum, disk) => ({ size: sum.size + disk.size, used: sum.used + disk.used, avail: sum.avail + disk.avail }),
        { size: 0, used: 0, avail: 0 },
    );
    diskTotal.pct = diskTotal.used + diskTotal.avail > 0
        ? Math.round((diskTotal.used / (diskTotal.used + diskTotal.avail)) * 100)
        : 0;

    return {
        success: true,
        supported: true,
        at: now,
        host: entry.identity,
        cpu: rates ? rates.cpu : null,
        mem: parseMeminfo(sections.mem),
        net: rates ? rates.net : null,
        uptime: parseUptime(sections.uptime, sections.load),
        users: parseWho(sections.who),
        disks,
        diskTotal,
    };
}

function cleanup(tabId) {
    byTab.delete(tabId);
}

module.exports = { sample, cleanup, SAMPLE_SCRIPT, IDENTITY_SCRIPT };
