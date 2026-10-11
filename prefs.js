'use strict';

const { Adw, Gdk, Gio, Gtk } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

const Me = ExtensionUtils.getCurrentExtension();
const U = Me.imports.utils;

function init() {
}

/* ---------- row helpers ---------- */

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.ActionRow({ title, subtitle });
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(sw);
    row.activatable_widget = sw;
    return row;
}

function spinRow(settings, key, title, min, max, step = 1, subtitle = '') {
    const row = new Adw.ActionRow({ title, subtitle });
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step, page_increment: step * 10 }),
        valign: Gtk.Align.CENTER,
    });
    settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(spin);
    return row;
}

function colorRow(settings, key, title) {
    const row = new Adw.ActionRow({ title });
    const btn = new Gtk.ColorButton({ use_alpha: true, valign: Gtk.Align.CENTER });
    const load = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)))
            btn.set_rgba(rgba);
    };
    load();
    btn.connect('color-set', () => settings.set_string(key, btn.get_rgba().to_string()));
    settings.connect(`changed::${key}`, load);
    row.add_suffix(btn);
    row.activatable_widget = btn;
    return row;
}

/* Combo row for a key with a fixed list of values. */
function comboRow(settings, key, title, values, labels, getter, setter, subtitle = '') {
    const row = new Adw.ComboRow({ title, subtitle, model: Gtk.StringList.new(labels) });
    const sync = () => {
        const idx = values.indexOf(getter(key));
        row.selected = idx >= 0 ? idx : 0;
    };
    sync();
    row.connect('notify::selected', () => {
        const v = values[row.selected];
        if (v !== undefined && v !== getter(key))
            setter(key, v);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function intervalRow(settings, key) {
    const values = [...U.INTERVALS];
    const cur = settings.get_int(key);
    if (!values.includes(cur))
        values.push(cur), values.sort((a, b) => a - b);
    return comboRow(settings, key, 'Interval', values, values.map(U.formatInterval),
        k => settings.get_int(k), (k, v) => settings.set_int(k, v),
        'Time per pixel of graph history');
}

/* Common rows for each graph: enable, width, interval. */
function graphGroup(page, settings, prefix, title, description = '') {
    const group = new Adw.PreferencesGroup({ title, description });
    group.add(switchRow(settings, `${prefix}-enabled`, 'Show'));
    group.add(spinRow(settings, `${prefix}-width`, 'Width', 10, 1000, 10, 'Graph width in pixels'));
    group.add(intervalRow(settings, `${prefix}-interval`));
    page.add(group);
    return group;
}

/* ---------- pages ---------- */

function generalPage(settings) {
    const page = new Adw.PreferencesPage({ title: 'General', icon_name: 'preferences-system-symbolic' });

    const panel = new Adw.PreferencesGroup({ title: 'Panel' });
    panel.add(comboRow(settings, 'panel-position', 'Position',
        ['left', 'center', 'right'], ['Left', 'Center', 'Right'],
        k => settings.get_string(k), (k, v) => settings.set_string(k, v)));
    panel.add(spinRow(settings, 'panel-index', 'Index', 0, 50, 1, 'Order within the panel area (0 = first)'));
    page.add(panel);

    const look = new Adw.PreferencesGroup({ title: 'Appearance' });
    look.add(switchRow(settings, 'show-labels', 'Show labels', 'Text label in front of each graph'));
    look.add(switchRow(settings, 'show-values', 'Show values', 'Current value drawn on top of each graph'));
    look.add(colorRow(settings, 'background-color', 'Background'));
    look.add(colorRow(settings, 'text-color', 'Value text'));
    page.add(look);

    return page;
}

function graphsPage(settings) {
    const page = new Adw.PreferencesPage({ title: 'Graphs', icon_name: 'utilities-system-monitor-symbolic' });

    let g = graphGroup(page, settings, 'cpu', 'CPU');
    g.add(colorRow(settings, 'cpu-user-color', 'User'));
    g.add(colorRow(settings, 'cpu-system-color', 'System'));
    g.add(colorRow(settings, 'cpu-nice-color', 'Nice'));
    g.add(switchRow(settings, 'cpu-show-iowait', 'Show I/O wait'));
    g.add(colorRow(settings, 'cpu-iowait-color', 'I/O wait'));

    g = graphGroup(page, settings, 'memory', 'Memory');
    g.add(colorRow(settings, 'memory-used-color', 'Used'));
    g.add(colorRow(settings, 'memory-cache-color', 'Buffers / cache'));

    g = graphGroup(page, settings, 'swap', 'Swap');
    g.add(colorRow(settings, 'swap-color', 'Used'));

    g = graphGroup(page, settings, 'net', 'Network',
        'Sum of all physical interfaces; scale adapts to the visible peak');
    g.add(colorRow(settings, 'net-down-color', 'Download'));
    g.add(colorRow(settings, 'net-up-color', 'Upload'));

    g = graphGroup(page, settings, 'io', 'Disk I/O',
        'Read/write speed summed over all physical disks; scale adapts to the visible peak');
    g.add(colorRow(settings, 'io-read-color', 'Read'));
    g.add(colorRow(settings, 'io-write-color', 'Write'));

    g = graphGroup(page, settings, 'temp', 'Temperature');
    const sensors = U.listTempSensors();
    const auto = U.resolveTempSensor('');
    const reading = s => {
        const t = U.readTemp(s.path);
        return t === null ? s.title : `${s.title}  (${Math.round(t)} °C)`;
    };
    const ids = ['', ...sensors.map(s => s.id)];
    const labels = [`Automatic${auto ? ` — ${auto.title}` : ''}`, ...sensors.map(reading)];
    const curSensor = settings.get_string('temp-sensor');
    if (curSensor && !ids.includes(curSensor)) {
        ids.push(curSensor);
        labels.push(`${curSensor} (not present)`);
    }
    g.add(comboRow(settings, 'temp-sensor', 'Sensor', ids, labels,
        k => settings.get_string(k), (k, v) => settings.set_string(k, v)));
    g.add(spinRow(settings, 'temp-min', 'Minimum', -50, 200, 5, '°C at the bottom of the graph'));
    g.add(spinRow(settings, 'temp-max', 'Maximum', 0, 250, 5, '°C at the top of the graph'));
    g.add(colorRow(settings, 'temp-color', 'Color'));

    g = graphGroup(page, settings, 'disk', 'Partitions', 'One usage graph per selected partition');
    g.add(colorRow(settings, 'disk-color', 'Used'));

    const parts = new Adw.PreferencesGroup({ title: 'Partitions to show' });
    const mounts = U.listMounts();
    for (const m of settings.get_strv('disk-mounts')) {
        if (!mounts.some(x => x.mount === m))
            mounts.push({ mount: m, device: 'not mounted', fstype: '' });
    }
    for (const m of mounts) {
        const row = new Adw.ActionRow({
            title: m.mount,
            subtitle: [m.device, m.fstype].filter(Boolean).join(' · '),
        });
        const check = new Gtk.CheckButton({ valign: Gtk.Align.CENTER });
        const sync = () => {
            check.active = settings.get_strv('disk-mounts').includes(m.mount);
        };
        sync();
        check.connect('toggled', () => {
            const list = settings.get_strv('disk-mounts');
            const has = list.includes(m.mount);
            if (check.active && !has) {
                // keep the order of the mount list
                const order = mounts.map(x => x.mount);
                list.push(m.mount);
                list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
                settings.set_strv('disk-mounts', list);
            } else if (!check.active && has) {
                settings.set_strv('disk-mounts', list.filter(x => x !== m.mount));
            }
        });
        settings.connect('changed::disk-mounts', sync);
        row.add_prefix(check);
        row.activatable_widget = check;
        parts.add(row);
    }
    page.add(parts);

    return page;
}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();
    window.add(generalPage(settings));
    window.add(graphsPage(settings));
    window.set_default_size(560, 760);
    window.search_enabled = true;
    // keep settings alive as long as the window
    window._settings = settings;
}
