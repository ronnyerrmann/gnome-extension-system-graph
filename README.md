# System Graph

Completely Claude created

GNOME Shell 42–44 panel extension with history graphs for:

- **CPU**: stacked user / nice / system / I/O wait, each with its own color
- **Memory**: used plus buffers/cache
- **Swap**
- **Network**: download and upload (all physical interfaces, auto-scaled)
- **CPU temperature**: any hwmon sensor, selectable (default: auto-detect `coretemp`/`k10temp`)
- **Partition usage**: % used for each selected mount point (same calculation as `df`)

Every graph has its own width (default 100 px) and interval (seconds per pixel:
1, 2, 3, 5, 10, 15, 30, 60, 120, 300 or 600). Each pixel column is one sample.
Click the graphs to see the exact values, open System Monitor or open Preferences.

Data is read straight from `/proc` and `/sys`, so libgtop is not needed.

## Install

```sh
ln -sfn "$PWD" ~/.local/share/gnome-shell/extensions/system-graph@ronnyerrmann
glib-compile-schemas schemas/
```

Restart GNOME Shell (X11: <kbd>Alt</kbd>+<kbd>F2</kbd>, `r`, <kbd>Enter</kbd>; Wayland: log out and back in), then:

```sh
gnome-extensions enable system-graph@ronnyerrmann
gnome-extensions prefs system-graph@ronnyerrmann
```

After changing `schemas/*.xml`, run `glib-compile-schemas schemas/` again.
Logs: `journalctl -f -o cat /usr/bin/gnome-shell`.
