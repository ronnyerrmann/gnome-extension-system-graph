/* System Graph — panel graphs for CPU, memory, swap, network,
 * temperature and partition usage. GNOME Shell 42–44 (legacy imports). */
'use strict';

const { GLib, GObject, Gio, St, Clutter } = imports.gi;
const Cairo = imports.cairo;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const U = Me.imports.utils;

/* Settings that require the set of graphs to be rebuilt. */
const REBUILD_KEYS = new Set([
    'cpu-enabled', 'memory-enabled', 'swap-enabled', 'net-enabled',
    'temp-enabled', 'disk-enabled', 'disk-mounts',
]);
/* Settings that require the indicator to be re-added to the panel. */
const REPLACE_KEYS = new Set(['panel-position', 'panel-index']);

const pct = v => `${Math.round(v * 100)}%`;

/* ------------------------------------------------------------------ */
/* Graph base class                                                    */
/* ------------------------------------------------------------------ */

var Graph = class Graph {
    /* prefix: settings key prefix (cpu, memory, …); label: short panel label */
    constructor(settings, prefix, label) {
        this._settings = settings;
        this._prefix = prefix;
        this._timerId = 0;
        this.history = [];

        this.actor = new St.BoxLayout({
            style_class: 'system-graph-item',
            y_align: Clutter.ActorAlign.FILL,
        });
        this._label = new St.Label({
            text: label,
            style_class: 'system-graph-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.area = new St.DrawingArea({
            style_class: 'system-graph-area',
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.area.connect('repaint', a => this._repaint(a));
        this.actor.add_child(this._label);
        this.actor.add_child(this.area);

        this.menuItem = new PopupMenu.PopupMenuItem('', { reactive: false });

        this._applyWidth();
        this._label.visible = settings.get_boolean('show-labels');
    }

    get width() {
        return this._settings.get_int(`${this._prefix}-width`);
    }

    get interval() {
        return Math.max(1, this._settings.get_int(`${this._prefix}-interval`));
    }

    color(name) {
        return U.parseColor(this._settings.get_string(name));
    }

    start() {
        this.update();
        this._restartTimer();
    }

    _restartTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.interval * 1000, () => {
            this.update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _applyWidth() {
        this.area.set_style(`width: ${this.width}px;`);
    }

    onSettingChanged(key) {
        if (key === `${this._prefix}-width`)
            this._applyWidth();
        else if (key === `${this._prefix}-interval`)
            this._restartTimer();
        else if (key === 'show-labels')
            this._label.visible = this._settings.get_boolean('show-labels');
        this.area.queue_repaint();
    }

    /* Override: return a sample (array of numbers) or null to skip. */
    sample() {
        return null;
    }

    update() {
        const v = this.sample();
        if (v)
            this.push(v);
    }

    push(v) {
        this.history.push(v);
        // keep enough samples for HiDPI surfaces as well
        const max = this.width * 4;
        if (this.history.length > max)
            this.history.splice(0, this.history.length - max);
        this.menuItem.label.text = this.describe();
        this.area.queue_repaint();
    }

    describe() {
        return '';
    }

    /* Short text drawn on the graph. */
    valueText() {
        return '';
    }

    _repaint(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        try {
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.setSourceRGBA(...this.color('background-color'));
            cr.rectangle(0, 0, w, h);
            cr.fill();
            cr.setOperator(Cairo.Operator.OVER);

            this.draw(cr, w, h);

            if (this._settings.get_boolean('show-values'))
                this._drawText(cr, w, h, this.valueText());
        } catch (e) {
            logError(e, 'system-graph: repaint');
        } finally {
            cr.$dispose();
        }
    }

    _drawText(cr, w, h, text) {
        if (!text)
            return;
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(Math.max(7, Math.min(12, Math.round(h * 0.45))));
        const ext = cr.textExtents(text);
        const x = 3;
        const y = Math.round((h - ext.height) / 2 - ext.yBearing);
        cr.setSourceRGBA(0, 0, 0, 0.7);
        cr.moveTo(x + 1, y + 1);
        cr.showText(text);
        cr.setSourceRGBA(...this.color('text-color'));
        cr.moveTo(x, y);
        cr.showText(text);
    }

    /* Visible samples, newest last, at most w of them. */
    _visible(w) {
        const n = Math.ceil(w);
        return this.history.slice(Math.max(0, this.history.length - n));
    }

    /* Stacked bars; samples are arrays of fractions 0..1. */
    drawStacked(cr, w, h, colors) {
        const data = this._visible(w);
        const x0 = w - data.length;
        colors.forEach((color, layer) => {
            if (!color)
                return;
            cr.setSourceRGBA(...color);
            data.forEach((s, i) => {
                let base = 0;
                for (let l = 0; l < layer; l++)
                    base += colors[l] ? s[l] || 0 : 0;
                const v = Math.max(0, Math.min(s[layer] || 0, 1 - base));
                if (v > 0)
                    cr.rectangle(x0 + i, h - (base + v) * h, 1, v * h);
            });
            cr.fill();
        });
    }

    /* Overlapping bars (each series from the bottom); values scaled by max. */
    drawOverlay(cr, w, h, colors, max) {
        const data = this._visible(w);
        const x0 = w - data.length;
        colors.forEach((color, series) => {
            cr.setSourceRGBA(...color);
            data.forEach((s, i) => {
                const v = Math.min(1, (s[series] || 0) / max);
                if (v > 0)
                    cr.rectangle(x0 + i, h - v * h, 1, v * h);
            });
            cr.fill();
        });
    }

    draw(cr, w, h) {
    }

    stop() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    destroy() {
        this.stop();
        this.menuItem.destroy();
        this.actor.destroy();
    }
};

/* ------------------------------------------------------------------ */

var CpuGraph = class CpuGraph extends Graph {
    constructor(settings) {
        super(settings, 'cpu', 'CPU');
        this._prev = null;
        this._last = null;
    }

    sample() {
        const cur = U.readCpu();
        const prev = this._prev;
        this._prev = cur;
        if (!cur || !prev)
            return null;
        const dt = cur.total - prev.total;
        if (dt <= 0)
            return null;
        const f = k => Math.max(0, cur[k] - prev[k]) / dt;
        // stack order: user, nice, system, iowait
        this._last = [f('user'), f('nice'), f('system'), f('iowait')];
        return this._last;
    }

    draw(cr, w, h) {
        this.drawStacked(cr, w, h, [
            this.color('cpu-user-color'),
            this.color('cpu-nice-color'),
            this.color('cpu-system-color'),
            this._settings.get_boolean('cpu-show-iowait') ? this.color('cpu-iowait-color') : null,
        ]);
    }

    _busy() {
        const [u, n, s] = this._last;
        return u + n + s;
    }

    valueText() {
        return this._last ? pct(this._busy()) : '';
    }

    describe() {
        const [u, n, s, io] = this._last;
        return `CPU: ${pct(this._busy())}   user ${pct(u)} · system ${pct(s)} · nice ${pct(n)} · iowait ${pct(io)}`;
    }
};

var MemoryGraph = class MemoryGraph extends Graph {
    constructor(settings) {
        super(settings, 'memory', 'MEM');
        this._m = null;
    }

    sample() {
        const m = U.readMeminfo();
        if (!m.MemTotal)
            return null;
        const total = m.MemTotal;
        const avail = m.MemAvailable ?? (m.MemFree + (m.Buffers || 0) + (m.Cached || 0));
        const used = total - avail;
        const cache = Math.max(0, total - m.MemFree - used);
        this._m = { total, used, cache };
        return [used / total, cache / total];
    }

    draw(cr, w, h) {
        this.drawStacked(cr, w, h, [
            this.color('memory-used-color'),
            this.color('memory-cache-color'),
        ]);
    }

    valueText() {
        return this._m ? pct(this._m.used / this._m.total) : '';
    }

    describe() {
        const { total, used, cache } = this._m;
        return `Memory: ${U.formatBytes(used * 1024)} / ${U.formatBytes(total * 1024)} (${pct(used / total)})   cache ${U.formatBytes(cache * 1024)}`;
    }
};

var SwapGraph = class SwapGraph extends Graph {
    constructor(settings) {
        super(settings, 'swap', 'SWAP');
        this._s = null;
    }

    sample() {
        const m = U.readMeminfo();
        const total = m.SwapTotal || 0;
        const used = total - (m.SwapFree || 0);
        this._s = { total, used };
        return [total ? used / total : 0];
    }

    draw(cr, w, h) {
        this.drawStacked(cr, w, h, [this.color('swap-color')]);
    }

    valueText() {
        if (!this._s)
            return '';
        return this._s.total ? pct(this._s.used / this._s.total) : 'off';
    }

    describe() {
        const { total, used } = this._s;
        if (!total)
            return 'Swap: none';
        return `Swap: ${U.formatBytes(used * 1024)} / ${U.formatBytes(total * 1024)} (${pct(used / total)})`;
    }
};

var NetGraph = class NetGraph extends Graph {
    constructor(settings) {
        super(settings, 'net', 'NET');
        this._prev = null;
        this._last = [0, 0];
    }

    sample() {
        const cur = U.readNet();
        const now = GLib.get_monotonic_time();
        const prev = this._prev;
        this._prev = cur ? { ...cur, time: now } : null;
        if (!cur || !prev)
            return null;
        const dt = (now - prev.time) / 1e6;
        if (dt <= 0)
            return null;
        // counters can go backwards when an interface disappears
        this._last = [
            Math.max(0, cur.rx - prev.rx) / dt,
            Math.max(0, cur.tx - prev.tx) / dt,
        ];
        return this._last;
    }

    draw(cr, w, h) {
        let max = 1024;
        for (const [d, u] of this._visible(w))
            max = Math.max(max, d, u);
        this.drawOverlay(cr, w, h, [
            this.color('net-down-color'),
            this.color('net-up-color'),
        ], max);
    }

    valueText() {
        const [d, u] = this._last;
        return `↓${U.formatBytes(d)} ↑${U.formatBytes(u)}`;
    }

    describe() {
        const [d, u] = this._last;
        return `Network: ↓ ${U.formatBytes(d, '/s')}   ↑ ${U.formatBytes(u, '/s')}`;
    }
};

var TempGraph = class TempGraph extends Graph {
    constructor(settings) {
        super(settings, 'temp', 'TEMP');
        this._t = null;
        this._resolve();
    }

    _resolve() {
        this._sensor = U.resolveTempSensor(this._settings.get_string('temp-sensor'));
    }

    onSettingChanged(key) {
        if (key === 'temp-sensor') {
            this._resolve();
            this.history = [];
            this.update();
        }
        super.onSettingChanged(key);
    }

    sample() {
        if (!this._sensor)
            return null;
        const t = U.readTemp(this._sensor.path);
        if (t === null) {
            // hwmon numbering may have changed (e.g. after resume); retry
            this._resolve();
            return null;
        }
        this._t = t;
        return [t];
    }

    draw(cr, w, h) {
        const min = this._settings.get_int('temp-min');
        const max = Math.max(min + 1, this._settings.get_int('temp-max'));
        const data = this._visible(w);
        const x0 = w - data.length;
        cr.setSourceRGBA(...this.color('temp-color'));
        data.forEach(([t], i) => {
            const v = Math.max(0, Math.min(1, (t - min) / (max - min)));
            if (v > 0)
                cr.rectangle(x0 + i, h - v * h, 1, v * h);
        });
        cr.fill();
    }

    valueText() {
        if (!this._sensor)
            return 'n/a';
        return this._t === null ? '' : `${Math.round(this._t)}°C`;
    }

    describe() {
        if (!this._sensor)
            return 'Temperature: no sensor found';
        return `Temperature (${this._sensor.title}): ${this._t.toFixed(1)} °C`;
    }

    update() {
        super.update();
        if (!this._sensor)
            this.menuItem.label.text = this.describe();
    }
};

var DiskGraph = class DiskGraph extends Graph {
    constructor(settings, mount) {
        const name = mount === '/' ? '/' : GLib.path_get_basename(mount);
        super(settings, 'disk', name.toUpperCase());
        this._mount = mount;
        this._name = name;
        this._d = null;
        this._busy = false;
        this._cancellable = new Gio.Cancellable();
        this._file = Gio.File.new_for_path(mount);
    }

    /* statfs can block on network filesystems, so query asynchronously. */
    update() {
        if (this._busy)
            return;
        this._busy = true;
        this._file.query_filesystem_info_async(
            'filesystem::size,filesystem::free,filesystem::used',
            GLib.PRIORITY_DEFAULT, this._cancellable, (file, res) => {
                this._busy = false;
                let info;
                try {
                    info = file.query_filesystem_info_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this.menuItem.label.text = `${this._mount}: unavailable`;
                    return;
                }
                const size = info.get_attribute_uint64('filesystem::size');
                const free = info.get_attribute_uint64('filesystem::free');
                const used = info.has_attribute('filesystem::used')
                    ? info.get_attribute_uint64('filesystem::used') : size - free;
                // same as df: used / (used + available to users)
                const frac = used + free > 0 ? used / (used + free) : 0;
                this._d = { size, used, frac };
                this.push([frac]);
            });
    }

    draw(cr, w, h) {
        this.drawStacked(cr, w, h, [this.color('disk-color')]);
    }

    valueText() {
        return this._d ? `${this._name} ${pct(this._d.frac)}` : this._name;
    }

    describe() {
        const { size, used, frac } = this._d;
        return `${this._mount}: ${pct(frac)} used (${U.formatBytes(used)} / ${U.formatBytes(size)})`;
    }

    stop() {
        this._cancellable.cancel();
        super.stop();
    }
};

/* ------------------------------------------------------------------ */
/* Indicator                                                           */
/* ------------------------------------------------------------------ */

const SystemGraphIndicator = GObject.registerClass(
class SystemGraphIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'System Graph', false);
        this._settings = settings;
        this._graphs = [];

        this._box = new St.BoxLayout({ style_class: 'system-graph-box' });
        this.add_child(this._box);

        this._valuesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._valuesSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('System Monitor', () => {
            Util.spawn(['gnome-system-monitor']);
        });
        this.menu.addAction('Preferences', () => ExtensionUtils.openPrefs());

        this._placeholder = null;
        // children are destroyed along with the button; only stop timers
        this.connect('destroy', () => this._graphs.forEach(g => g.stop()));
        this.rebuild();
    }

    rebuild() {
        this._graphs.forEach(g => g.destroy());
        this._graphs = [];
        this._placeholder?.destroy();
        this._placeholder = null;

        const s = this._settings;
        const g = [];
        if (s.get_boolean('cpu-enabled'))
            g.push(new CpuGraph(s));
        if (s.get_boolean('memory-enabled'))
            g.push(new MemoryGraph(s));
        if (s.get_boolean('swap-enabled'))
            g.push(new SwapGraph(s));
        if (s.get_boolean('net-enabled'))
            g.push(new NetGraph(s));
        if (s.get_boolean('temp-enabled'))
            g.push(new TempGraph(s));
        if (s.get_boolean('disk-enabled')) {
            for (const mount of s.get_strv('disk-mounts'))
                g.push(new DiskGraph(s, mount));
        }
        for (const graph of g) {
            this._box.add_child(graph.actor);
            this._valuesSection.addMenuItem(graph.menuItem);
            graph.start();
        }
        this._graphs = g;
        // keep something clickable in the panel even with all graphs off
        if (!g.length) {
            this._placeholder = new St.Label({
                text: 'System Graph',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._box.add_child(this._placeholder);
        }
    }

    onSettingChanged(key) {
        this._graphs.forEach(g => g.onSettingChanged(key));
    }
});

/* ------------------------------------------------------------------ */

class Extension {
    enable() {
        this._settings = ExtensionUtils.getSettings();
        this._addIndicator();
        this._settingsId = this._settings.connect('changed', (s, key) => {
            if (REPLACE_KEYS.has(key)) {
                this._indicator.destroy();
                this._addIndicator();
            } else if (REBUILD_KEYS.has(key)) {
                this._indicator.rebuild();
            } else {
                this._indicator.onSettingChanged(key);
            }
        });
    }

    _addIndicator() {
        this._indicator = new SystemGraphIndicator(this._settings);
        Main.panel.addToStatusArea(Me.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
    }

    disable() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}

function init() {
    return new Extension();
}
