/**
 * The readers behind the resource bar under each SSH pane.
 *
 * Fixtures are real output from the tools the collector runs, including the
 * shapes that trip up a naive split: busybox's df without -T, mount points
 * with spaces, kernels without MemAvailable, counters that went backwards.
 */
const path = require('path');
const assert = require('assert');

const {
    splitSections,
    parseCpu,
    parseMeminfo,
    parseNetDev,
    parseUptime,
    parseWho,
    parseDf,
    computeRates,
} = require(path.join(__dirname, '..', 'src', 'main', 'resource-stats-parse.js'));

let passed = 0;
const check = (label, fn) => {
    try {
        fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        process.exitCode = 1;
    }
};

console.log('\nresource stats: sections');

check('splits on marker lines and trims each section', () => {
    const sections = splitSections('noise\n@@host\nweb01\n@@stat\ncpu  1 2 3 4\n\n@@who\n');
    assert.deepStrictEqual(sections, { host: 'web01', stat: 'cpu  1 2 3 4', who: '' });
});

console.log('\nresource stats: /proc');

check('reads the aggregate cpu line, iowait counted as idle', () => {
    const cpu = parseCpu('cpu  100 5 50 800 40 0 5 0 0 0\ncpu0 50 2 25 400 20 0 2 0 0 0');
    assert.deepStrictEqual(cpu, { total: 1000, idle: 840 });
});

check('has no cpu reading without /proc/stat', () => {
    assert.strictEqual(parseCpu(''), null);
    assert.strictEqual(parseCpu("'head' is not recognized as an internal command"), null);
});

check('reads meminfo with MemAvailable', () => {
    const mem = parseMeminfo([
        'MemTotal:        8000000 kB',
        'MemFree:         1000000 kB',
        'MemAvailable:    5000000 kB',
        'Buffers:          200000 kB',
        'Cached:          3000000 kB',
        'SReclaimable:     100000 kB',
        'SwapTotal:       2000000 kB',
        'SwapFree:        1500000 kB',
    ].join('\n'));
    assert.strictEqual(mem.total, 8000000 * 1024);
    assert.strictEqual(mem.available, 5000000 * 1024);
    assert.strictEqual(mem.used, 3000000 * 1024);
    assert.strictEqual(mem.cached, 3100000 * 1024);
    assert.strictEqual(mem.buffers, 200000 * 1024);
    assert.strictEqual(mem.swapFree, 1500000 * 1024);
});

check('estimates available memory on kernels without MemAvailable', () => {
    const mem = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB');
    assert.strictEqual(mem.available, 400 * 1024);
    assert.strictEqual(mem.used, 600 * 1024);
});

check('reads net/dev and leaves out loopback', () => {
    const net = parseNetDev([
        'Inter-|   Receive                                                |  Transmit',
        ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
        '    lo: 9999 10 0 0 0 0 0 0 9999 10 0 0 0 0 0 0',
        '  eth0:12345 100 0 0 0 0 0 0 67890 90 0 0 0 0 0 0',
        'wlan0: 1 1 0 0 0 0 0 0 2 1 0 0 0 0 0 0',
    ].join('\n'));
    assert.deepStrictEqual(net, [
        { iface: 'eth0', rx: 12345, tx: 67890 },
        { iface: 'wlan0', rx: 1, tx: 2 },
    ]);
});

check('reads uptime and load averages', () => {
    assert.deepStrictEqual(parseUptime('350735.47 234388.90', '0.52 0.58 0.59 1/257 12345'), {
        seconds: 350735,
        load: [0.52, 0.58, 0.59],
    });
    assert.deepStrictEqual(parseUptime('', ''), { seconds: null, load: null });
});

console.log('\nresource stats: who');

check('reads ISO and short dates, with and without a source', () => {
    const users = parseWho([
        'gp       pts/0        2026-09-29 10:12 (192.168.1.5)',
        'root     tty1         Sep 29 09:01',
        'deploy   pts/3        2026-09-29 11:40 (tmux(1234).%0)',
    ].join('\n'));
    assert.deepStrictEqual(users[0], { user: 'gp', tty: 'pts/0', when: '2026-09-29 10:12', from: '192.168.1.5' });
    assert.deepStrictEqual(users[1], { user: 'root', tty: 'tty1', when: 'Sep 29 09:01', from: '' });
    assert.strictEqual(users[2].user, 'deploy');
    assert.strictEqual(users.length, 3);
});

console.log('\nresource stats: df');

check('reads df -PTk and drops pseudo filesystems', () => {
    const disks = parseDf([
        'Filesystem     Type     1024-blocks      Used Available Capacity Mounted on',
        'udev           devtmpfs     4000000         0   4000000       0% /dev',
        'tmpfs          tmpfs         800000      1500    798500       1% /run',
        '/dev/sda1      ext4       100000000  42000000  58000000      42% /',
        '/dev/loop0     squashfs       56000     56000         0     100% /snap/core/1',
        '/dev/sdb1      xfs        200000000 140000000  60000000      71% /home',
    ].join('\n'));
    assert.deepStrictEqual(disks.map(disk => disk.mount), ['/', '/home']);
    assert.deepStrictEqual(disks[0], {
        fs: '/dev/sda1',
        type: 'ext4',
        size: 100000000 * 1024,
        used: 42000000 * 1024,
        avail: 58000000 * 1024,
        pct: 42,
        mount: '/',
    });
});

check('reads busybox df -Pk without a type column', () => {
    const disks = parseDf([
        'Filesystem           1024-blocks    Used Available Capacity Mounted on',
        '/dev/root               1000000  500000    500000  50% /',
        'tmpfs                     10000       0     10000   0% /tmp',
    ].join('\n'));
    assert.deepStrictEqual(disks.map(disk => [disk.mount, disk.type, disk.pct]), [['/', '', 50]]);
});

check('keeps mount points with spaces whole', () => {
    const disks = parseDf([
        'Filesystem Type 1024-blocks Used Available Capacity Mounted on',
        '/dev/sdc1 ntfs 1000 250 750 25% /media/gp/My Disk',
    ].join('\n'));
    assert.strictEqual(disks[0].mount, '/media/gp/My Disk');
});

check('shows a bind-mounted device once', () => {
    const disks = parseDf([
        'Filesystem Type 1024-blocks Used Available Capacity Mounted on',
        '/dev/sda1 ext4 1000 500 500 50% /',
        '/dev/sda1 ext4 1000 500 500 50% /var/lib/docker/bind',
        'nas:/export nfs4 5000 1000 4000 20% /mnt/nas',
    ].join('\n'));
    assert.deepStrictEqual(disks.map(disk => disk.mount), ['/', '/mnt/nas']);
});

console.log('\nresource stats: rates');

check('has nothing to compare on the first sample', () => {
    assert.strictEqual(computeRates(null, { cpu: { total: 1, idle: 1 }, net: [] }, 2000), null);
});

check('turns counter deltas into cpu % and bytes per second', () => {
    const prev = { cpu: { total: 1000, idle: 800 }, net: [{ iface: 'eth0', rx: 1000, tx: 500 }] };
    const cur = { cpu: { total: 1200, idle: 950 }, net: [{ iface: 'eth0', rx: 5000, tx: 2500 }] };
    const rates = computeRates(prev, cur, 2000);
    assert.strictEqual(rates.cpu, 25);
    assert.deepStrictEqual(rates.net, {
        up: 1000,
        down: 2000,
        ifaces: [{ iface: 'eth0', up: 1000, down: 2000 }],
    });
});

check('reads a counter that went backwards as zero', () => {
    const prev = { cpu: { total: 5000, idle: 4000 }, net: [{ iface: 'eth0', rx: 9000, tx: 9000 }] };
    const cur = { cpu: { total: 100, idle: 90 }, net: [{ iface: 'eth0', rx: 10, tx: 10 }] };
    const rates = computeRates(prev, cur, 2000);
    assert.strictEqual(rates.cpu, 0);
    assert.strictEqual(rates.net.up, 0);
    assert.strictEqual(rates.net.down, 0);
});

check('skips an interface that appeared between samples', () => {
    const prev = { cpu: null, net: [] };
    const cur = { cpu: null, net: [{ iface: 'tun0', rx: 100, tx: 100 }] };
    assert.deepStrictEqual(computeRates(prev, cur, 1000).net.ifaces, []);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}\n`);
