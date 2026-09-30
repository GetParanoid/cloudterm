import { memo } from 'react';
import {
    ArrowDown02Icon,
    ArrowUp02Icon,
    Clock01Icon,
    ComputerIcon,
    CpuIcon,
    HardDriveIcon,
    RamMemoryIcon,
    UserMultipleIcon,
} from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import { formatSize } from '../../lib/format';
import { CPU_HISTORY } from '../../hooks/useResourceStats';

/**
 * The strip under an SSH pane saying how its server is doing: hostname, CPU
 * with the last minute graphed, memory, network, uptime, who is logged in, and
 * disk use, each with its detail on hover. The same readout MobaXterm keeps
 * under its sessions.
 *
 * It fits a pane of any width without measuring anything. The row wraps, and
 * the bar is exactly one line tall with overflow hidden, so whatever does not
 * fit wraps out of sight whole, from the end. The order is therefore also the
 * priority: individual partitions go first, the hostname and CPU last.
 */

const ICON = { size: 13, strokeWidth: 2, className: 'shrink-0 text-gray-400 dark:text-neutral-500' };

/** Green, then amber, then red, at the thresholds most monitoring uses. */
function levelClass(pct) {
    if (pct >= 90) return 'text-red-500';
    if (pct >= 70) return 'text-amber-500';
    return 'text-gray-700 dark:text-gray-200';
}

function meterClass(pct) {
    if (pct >= 90) return 'bg-red-500';
    if (pct >= 70) return 'bg-amber-500';
    return 'bg-emerald-500';
}

const percent = value => (typeof value === 'number' ? `${Math.round(value)}%` : '—');

const rate = value => `${formatSize(Math.max(0, value || 0))}/s`;

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * `6.9 / 15.6 GB`: both figures in the unit the total calls for, so the two
 * can be compared at a glance and the unit is written once.
 */
function formatOfTotal(used, total) {
    const exponent = total > 0
        ? Math.min(Math.floor(Math.log(total) / Math.log(1024)), SIZE_UNITS.length - 1)
        : 0;
    const scale = 1024 ** exponent;
    const decimals = exponent === 0 ? 0 : total / scale < 100 ? 1 : 0;
    return `${(used / scale).toFixed(decimals)} / ${(total / scale).toFixed(decimals)} ${SIZE_UNITS[exponent]}`;
}

function formatUptime(seconds) {
    if (typeof seconds !== 'number') return '—';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function formatUptimeLong(seconds) {
    if (typeof seconds !== 'number') return 'Unknown';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
    if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    return parts.join(', ');
}

/* ------------------------------------------------------------------ *
 * Tooltip bodies
 * ------------------------------------------------------------------ */

function Title({ children }) {
    return <span className="font-semibold text-gray-900 dark:text-white">{children}</span>;
}

/** Name/value pairs, names muted, values aligned. */
function Pairs({ rows }) {
    return (
        <span className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5">
            {rows.map(([name, value]) => [
                <span key={`${name}-n`} className="text-gray-500 dark:text-gray-400">{name}</span>,
                <span key={`${name}-v`} className="text-right tabular-nums">{value}</span>,
            ])}
        </span>
    );
}

/** A small table: a muted header row, then the data. */
function Table({ columns, rows, align = [] }) {
    return (
        <span
            className="grid gap-x-4 gap-y-1.5"
            style={{ gridTemplateColumns: `repeat(${columns.length}, auto)` }}
        >
            {columns.map(column => (
                <span key={`h-${column}`} className="text-gray-500 dark:text-gray-400">{column}</span>
            ))}
            {rows.map((row, rowIndex) => row.map((cell, cellIndex) => (
                <span
                    key={`${rowIndex}-${cellIndex}`}
                    className={`tabular-nums ${align[cellIndex] === 'right' ? 'text-right' : ''}`}
                >
                    {cell}
                </span>
            )))}
        </span>
    );
}

function Details({ title, children }) {
    return (
        <span className="flex flex-col gap-2 leading-tight">
            <Title>{title}</Title>
            {children}
        </span>
    );
}

/* ------------------------------------------------------------------ *
 * Bar pieces
 * ------------------------------------------------------------------ */

function Segment({ tip, label, children, className = '' }) {
    return (
        <Tooltip label={tip} placement="top">
            <span
                role="group"
                aria-label={label}
                className={`h-7 flex items-center gap-1.5 cursor-default ${className}`}
            >
                {children}
            </span>
        </Tooltip>
    );
}

/** A thin horizontal gauge. */
function Meter({ pct }) {
    const clamped = Math.max(0, Math.min(100, pct || 0));
    return (
        <span className="block w-8 h-1.5 shrink-0 rounded-full overflow-hidden bg-gray-200 dark:bg-surface-control">
            <span className={`block h-full rounded-full ${meterClass(clamped)}`} style={{ width: `${clamped}%` }} />
        </span>
    );
}

/**
 * A mount point, set in a chip. Bare, the root mount is a lone `/` between two
 * figures, which reads as a separator rather than as the name of a disk.
 */
function MountName({ mount }) {
    return (
        <span className="max-w-[10rem] truncate px-1 rounded font-mono text-[10px] leading-4
            bg-gray-100 dark:bg-surface-control text-gray-700 dark:text-gray-200">
            {mount}
        </span>
    );
}

const GRAPH_WIDTH = 60;
const GRAPH_HEIGHT = 14;

/**
 * The last minute of CPU, oldest at the left. Drawn against a fixed 0–100
 * scale so a flat 3% looks flat rather than like a crisis, and right-aligned
 * so a fresh connection fills in from where the newest sample lands.
 */
function Sparkline({ history }) {
    const step = GRAPH_WIDTH / (CPU_HISTORY - 1);
    const offset = GRAPH_WIDTH - (history.length - 1) * step;
    const y = value => GRAPH_HEIGHT - 1 - (Math.max(0, Math.min(100, value)) / 100) * (GRAPH_HEIGHT - 2);
    const points = history.map((value, index) => `${(offset + index * step).toFixed(1)},${y(value).toFixed(1)}`);

    return (
        <svg
            width={GRAPH_WIDTH}
            height={GRAPH_HEIGHT}
            viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
            className="shrink-0 rounded-sm bg-gray-100 dark:bg-surface-control text-emerald-500"
            aria-hidden="true"
        >
            {history.length > 1 && (
                <>
                    <polygon
                        points={`${offset.toFixed(1)},${GRAPH_HEIGHT} ${points.join(' ')} ${GRAPH_WIDTH},${GRAPH_HEIGHT}`}
                        fill="currentColor"
                        opacity="0.2"
                    />
                    <polyline
                        points={points.join(' ')}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinejoin="round"
                    />
                </>
            )}
        </svg>
    );
}

/* ------------------------------------------------------------------ *
 * The bar
 * ------------------------------------------------------------------ */

function ResourceBar({ stats, history = [], hostFallback = '', dimmed = false, unsupported = false }) {
    const host = stats?.host || {};
    const hostName = host.name || hostFallback;

    const hostTip = (
        <Details title={hostName || 'Unknown host'}>
            {unsupported ? (
                <span className="text-gray-500 dark:text-gray-400">
                    Resource usage needs a Linux host (/proc)
                </span>
            ) : (
                <Pairs rows={[
                    ['System', host.os || 'Unknown'],
                    ['Kernel', host.kernel || 'Unknown'],
                ]}
                />
            )}
        </Details>
    );

    const hostSegment = (
        <Segment tip={hostTip} label={`Host ${hostName}`}>
            <ComputerIcon {...ICON} />
            <span className="max-w-[14rem] truncate font-medium text-gray-700 dark:text-gray-200">
                {hostName || '—'}
            </span>
        </Segment>
    );

    const shell = children => (
        <div
            className={`shrink-0 h-7 flex flex-wrap items-center content-start gap-x-4 px-3 overflow-hidden
                bg-white dark:bg-surface-raised border-t border-gray-200 dark:border-surface-control
                text-[11px] text-gray-500 dark:text-gray-400 tabular-nums select-none
                transition-opacity duration-200 ${dimmed ? 'opacity-60' : 'opacity-100'}`}
            aria-label="Server resource usage"
        >
            {children}
        </div>
    );

    if (unsupported) return shell(hostSegment);

    const cpu = stats?.cpu;
    const mem = stats?.mem;
    const memPct = mem?.total ? (mem.used / mem.total) * 100 : null;
    const net = stats?.net;
    const uptime = stats?.uptime;
    const users = stats?.users || [];
    // Root first: it is the one shown without a name, straight after the drive
    // icon, so it has to be the one next to it.
    const disks = [...(stats?.disks || [])].sort((a, b) => (b.mount === '/') - (a.mount === '/'));
    const diskTotal = stats?.diskTotal;
    const load = uptime?.load;

    const interfaces = net?.ifaces || [];
    const networkTip = direction => (
        <Details title={direction === 'up' ? 'Upload' : 'Download'}>
            {interfaces.length ? (
                <Pairs rows={interfaces.map(entry => [entry.iface, rate(entry[direction])])} />
            ) : (
                <span className="text-gray-500 dark:text-gray-400">Measuring…</span>
            )}
        </Details>
    );

    const diskRow = disk => [
        disk.fs,
        disk.type || '—',
        formatSize(disk.size),
        formatSize(disk.used),
        formatSize(disk.avail),
        `${disk.pct}%`,
        disk.mount,
    ];
    const DISK_COLUMNS = ['Filesystem', 'Type', 'Size', 'Used', 'Avail', 'Use%', 'Mounted on'];
    const DISK_ALIGN = ['left', 'left', 'right', 'right', 'right', 'right', 'left'];

    // Every filesystem's segment opens the same df table, so the one hovered
    // is read alongside the rest. The total only means something with more
    // than one row to add up.
    const storageTip = (
        <Details title="Storage">
            <Table columns={DISK_COLUMNS} rows={disks.map(diskRow)} align={DISK_ALIGN} />
            {disks.length > 1 && diskTotal && (
                <Pairs rows={[[
                    'All filesystems',
                    `${formatSize(diskTotal.used)} of ${formatSize(diskTotal.size)} (${diskTotal.pct}%)`,
                ]]}
                />
            )}
        </Details>
    );

    return shell(
        <>
            {hostSegment}

            <Segment
                label={`CPU ${percent(cpu)}`}
                tip={(
                    <Details title="CPU">
                        <Pairs rows={[['Load', percent(cpu)]]} />
                    </Details>
                )}
            >
                <CpuIcon {...ICON} />
                <span className={`w-8 text-right ${typeof cpu === 'number' ? levelClass(cpu) : ''}`}>
                    {percent(cpu)}
                </span>
                <Sparkline history={history} />
            </Segment>

            {mem && (
                <Segment
                    label={`Memory ${percent(memPct)}, ${formatOfTotal(mem.used, mem.total)}`}
                    tip={(
                        <Details title="Memory">
                            <Pairs rows={[
                                ['Total', formatSize(mem.total)],
                                ['Used', formatSize(mem.used)],
                                ['Available', formatSize(mem.available)],
                                ['Cached', formatSize(mem.cached)],
                                ['Buffers', formatSize(mem.buffers)],
                                ...(mem.swapTotal
                                    ? [['Swap used', `${formatSize(mem.swapTotal - mem.swapFree)} of ${formatSize(mem.swapTotal)}`]]
                                    : []),
                            ]}
                            />
                        </Details>
                    )}
                >
                    <RamMemoryIcon {...ICON} />
                    <span className={levelClass(memPct)}>{percent(memPct)}</span>
                    <span className="text-gray-700 dark:text-gray-200">{formatOfTotal(mem.used, mem.total)}</span>
                    <Meter pct={memPct} />
                </Segment>
            )}

            <Segment label={`Upload ${net ? rate(net.up) : ''}`} tip={networkTip('up')}>
                <ArrowUp02Icon {...ICON} />
                <span className="text-gray-700 dark:text-gray-200">{net ? rate(net.up) : '—'}</span>
            </Segment>

            <Segment label={`Download ${net ? rate(net.down) : ''}`} tip={networkTip('down')}>
                <ArrowDown02Icon {...ICON} />
                <span className="text-gray-700 dark:text-gray-200">{net ? rate(net.down) : '—'}</span>
            </Segment>

            {uptime && (
                <Segment
                    label={`Uptime ${formatUptime(uptime.seconds)}`}
                    tip={(
                        <Details title="Uptime">
                            <Pairs rows={[
                                ['Up', formatUptimeLong(uptime.seconds)],
                                ...(load
                                    ? [
                                        ['Load (1 min)', load[0].toFixed(2)],
                                        ['Load (5 min)', load[1].toFixed(2)],
                                        ['Load (15 min)', load[2].toFixed(2)],
                                    ]
                                    : []),
                            ]}
                            />
                        </Details>
                    )}
                >
                    <Clock01Icon {...ICON} />
                    <span className="text-gray-700 dark:text-gray-200">{formatUptime(uptime.seconds)}</span>
                </Segment>
            )}

            {stats && (
                <Segment
                    label={`${users.length} logged in`}
                    tip={(
                        <Details title="Logged in">
                            {users.length ? (
                                <Table
                                    columns={['User', 'Terminal', 'Since', 'From']}
                                    rows={users.map(entry => [entry.user, entry.tty, entry.when, entry.from || '—'])}
                                />
                            ) : (
                                <span className="text-gray-500 dark:text-gray-400">Nobody is listed by who</span>
                            )}
                        </Details>
                    )}
                >
                    <UserMultipleIcon {...ICON} />
                    <span className="text-gray-700 dark:text-gray-200">{users.length}</span>
                </Segment>
            )}

            {/* One figure per filesystem, and nothing else. A total across all
                of them sat here once, and beside a root partition holding most
                of the data it printed the same percentage twice. It lives in
                the tooltip instead, under the table it sums. The drive icon
                marks where storage starts, so it goes on the first only. */}
            {disks.map((disk, index) => (
                <Segment
                    key={disk.mount}
                    label={`Storage ${disk.mount} ${disk.pct}% used`}
                    tip={storageTip}
                >
                    {index === 0 && <HardDriveIcon {...ICON} />}
                    {/* The root is the disk; the icon already says so, and a
                        lone `/` beside it reads as punctuation. */}
                    {disk.mount !== '/' && <MountName mount={disk.mount} />}
                    <span className={levelClass(disk.pct)}>{disk.pct}%</span>
                    <Meter pct={disk.pct} />
                </Segment>
            ))}
        </>,
    );
}

export default memo(ResourceBar);
