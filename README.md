# Vacuum Monitoring

Pressure and temperature monitoring for the beamline gauges — the INFICON
BCG450, the Pfeiffer TPG 36x, the Edwards TIC and the Lake Shore 218 — over
their serial lines.

It replaces `pressure-bcg450/cmms-web`, and answers the two things that were
hard to do with it: **saying where a number came from**, and **choosing what
part of the run to look at**.

```
backend/    FastAPI service, the measurement loop, and the instrument drivers
frontend/   React UI (Mantine + uPlot)
```

## Running it

```bash
# 1. backend dependencies (once)
pip install -r backend/requirements.txt

# 2. build the UI (once, and after any frontend change)
cd frontend && npm install && npm run build && cd ..

# 3. start
./start_server.sh          # or: cd backend && python run.py
```

`run.py` listens on `0.0.0.0:8002` and prints every LAN URL it can be opened
on. It serves both the API and the built UI, so there is one process and one
port. `./stop_server.sh` shuts it down cleanly — serial ports released, CSVs
closed.

| | |
|---|---|
| `python run.py --port 8003` | different port |
| `python run.py --host 127.0.0.1` | this machine only |
| `python run.py --attach` | read-only: open the saved logs, no instrument |
| `http://<host>:8002/docs` | interactive API docs |

### Developing the UI

```bash
cd backend  && python run.py            # API on :8002
cd frontend && npm run dev              # Vite on :5173, proxies /api and /ws
```

There is no separate simulator: **M1** and **M2** are device types like any
other, they open nothing, and they produce a moving pressure and three moving
temperatures. Add one from the Sources tab when you are away from the bench.

## Taking over from cmms-web

The old service holds `/dev/ttyUSB0`, so only one of them can read the gauge.
To switch:

```bash
cd /home/cens-alpha-00/pressure-bcg450/cmms-web && ./stop_server.sh
./start_server.sh
```

Then open the Sources tab, pick the port and the instrument, and press Open.
The device is remembered in `backend/data/devices.json` and reopened on every
later start.

Nothing already written is lost.

```bash
python3 backend/tools/import_logs.py --dry-run   # say what it would do
python3 backend/tools/import_logs.py             # do it
```

The BCG450's history was spread across five directories, left behind as the
logging moved between installs. The importer copies them all into
`backend/log/CSV/` so the Logs tab reaches the lot: about three months, 225 MB,
28 days of actual readings from 2026-05-12 onward. Originals are not moved and
not rewritten; the copies keep the header they were written with, which this
service reads. What changes is the name — a file becomes
`<device>_<when its first sample was taken>.csv`, so the directory sorts
chronologically. Where each came from is recorded in `.imported.json` beside
them and shown in the Logs tab.

It is safe to run twice: a file already copied is skipped, and one that has
grown since (the log the old service is writing right now) is re-copied. Run it
once more after the cutover to pick up the last rows.

## How it works

One thread reads every open device once a second and appends the readings to a
ring buffer per channel, 24 hours deep. Everything else reads that buffer.

```
gauge ──serial──▶ monitor thread ──▶ ring buffer ──▶ /api/devices/…/series ──▶ chart
                        │                                (a time window)
                        └──▶ CSV on disk                  ◀── /ws/status (latest only)
```

The split matters. The previous service put the whole buffered history in
every status poll — twenty-one thousand points per channel, several times a
second, which is why its server log had grown to 182 MB. Here the socket
carries only the current reading (about 650 bytes a frame, whatever the run
length) and history is a query against the window a chart is showing. A day of
data comes back in 60 kB and about 50 ms.

### Continue, or New

A profile remembers every log it has written. Connecting offers both:

- **Continue** stitches this run onto those logs, so the chart carries on from
  where the last one stopped rather than starting at nothing. A service restart
  always continues — a restart is not a new experiment.
- **New** draws only what this run writes. The earlier logs stay on disk and
  can still be opened from Attach; they are just off this chart.

The same stitching is what makes a *long* run scrollable. A live channel holds
a day in memory; past that the chart reads the run's own file. So the buffer's
edge is invisible: scrolling back past midnight simply keeps working, and with
Continue it keeps working past the start of this run.

### Two sources, one shape

A device is a set of channels with timestamped samples, however it was read:

- **Live instruments** — the gauges on this machine, and any other host running
  this service. Both are *profiles*: a name you press Connect on. A remote
  host's devices appear as tabs of their own and their readings are written to
  this machine's log directory like any other, so mirroring leaves a record
  here rather than only on the other end. The older cmms-web's API is
  understood as well as this one's.
- **Attach to CSV** — logs already in that directory, opened as tabs. Pick
  several and they are drawn as one continuous trace.

The two are mutually exclusive and switching closes everything, on purpose: a
panel that could mix a live gauge with a file is a panel where "what am I
looking at" has no single answer.

Everything lives in **one directory**. There is no path to point at somewhere
else and no second copy of anything: what is written is what is read.

### Memory

A live channel keeps its last **24 hours** in memory — 86 400 samples at 66
bytes each, about **5.5 MB**. That is a ceiling, not a rate: running for a month
costs exactly the same, because older samples fall out of the buffer and live
only in the file. Eight channels of a Lake Shore is 43 MB; the whole process
sits under 50 MB.

A tab made of files keeps **nothing**. Only the window on screen is read, from
the files it actually touches, so opening a hundred days of logs costs the same
as opening one run. Reading three and a half months takes about three seconds;
a day, a quarter of one.

The browser holds at most 2 000 points per channel, whatever the window.

What does grow is disk: **about 8.6 MB per day per channel**, so a month of one
gauge is roughly 260 MB.

### Where the numbers come from

Every device tab carries the account, and it is open by default:

- **The instrument** — type, what it is, the serial settings, the USB id, when
  it was opened, how many reads have succeeded and how long the last one took.
- **The channel** — the driver call the value comes from (`BCG450.get_pr()`),
  what is asked on the wire (`KRDG? 3`), the unit the device itself reported,
  the unit on the chart, and the factor between them.
- **Sampling** — read every second, and plotted exactly as the instrument
  reported it. What is held in memory and what is only in the file, said
  explicitly.
- **On disk** — the file, which column, how many rows, how big, and a download
  link.
- **The samples themselves** — the last twelve readings as numbers, in the
  instrument's own unit, refreshed every five seconds. A chart is an argument
  about the data; this is the data.

`app/catalog.py` is where that account lives. It is the written-down reading of
`drivers/`, kept beside it. If the two ever disagree the driver is right and
the catalog is a bug.

### The chart

uPlot, with the time axis under direct control:

| | |
|---|---|
| **Presets** | 1 m · 10 m · 1 h · 6 h · 24 h · All |
| **Drag** across the plot | zoom to that interval |
| **Wheel** | zoom about the pointer |
| **Shift-drag** | pan |
| **Double-click** | back to the preset |
| **Arrows** | pan by half a window; **± ** zoom by two |
| **From / To** | type a bound — `2026-08-29 14:30`, or just `14:30` for today |
| **Live** | pin the right edge to now; any gesture that chooses an end releases it |

Every one of them is clamped to where the samples actually are. Scrolling into
blank axis reads as "the gauge stopped" rather than "there is nothing here", so
the window slides against the ends instead, and the pan arrows grey out when
there is nothing further to see.

A zoom is a new query, not a magnification: the server is asked for the samples
inside the new bounds, so zooming in reveals detail that was never on screen.

Windows wider than the chart is are reduced by **keeping the highest and lowest
sample of each interval**, so a pressure burst one sample wide survives being
zoomed out to a day — a plain stride would step over it. The card says how many
points are drawn from how many samples, and when a large file had to be read
every nth row it says that too.

The y axis is logarithmic by default for pressure, because a pumpdown runs from
1000 mbar to 1e-9 mbar and a linear axis puts ten of those decades on the
floor. A reading of zero — what a TPG reports for a gauge that is switched off
— is a gap rather than a point, since it is not a measurement.

Series colours are the validated eight-hue categorical set, assigned in fixed
order; the order is what makes them safe for red-green colour blindness.

### The CSV files

This service writes:

```
time,unix_time,elapsed_s,channel,channel_label,value,unit,measure,device_type,device_name
```

`cmms-web` and the original CMMS program wrote:

```
time,unix_time,elapsed_s,channel,pressure_raw,raw_unit,pressure_display,display_unit
```

Both are read. `unix_time` is the column every chart is drawn from; `time` is
wrapped as `="…"` so Excel does not reinterpret it, which is how the old files
did it. A conversion between units is applied on the way *out* to a chart and
never on the way in — what is in the file is always what the instrument said.

One file per device per run, named `<device>_<when it started>.csv`, under
`backend/log/CSV/`. The file is created by the first reading, so opening the
wrong port leaves nothing behind — the directory this replaces has eighteen
header-only CSVs in it, one for each time that happened.

A log that lost its header line is still read: if the first row parses as data,
the legacy columns are assumed. One file on this machine is like that.

**The unit is written on every row.** The service this replaces read the unit
from the gauge once, when the device was added, and labelled everything after
that with it. On 2026-08-28 it cached `Torr` for a gauge that was reporting
mbar, and 30 hours of readings carry the wrong unit as a result — the values
are right, the label is not. Reading the unit every poll is what caught it, and
recording it per row is what stops it recurring.

## Layout

```
backend/
  run.py                  entry point, LAN URL discovery
  requirements.txt
  data/profiles.json      saved instruments and remote hosts, and the logs
                          each has written
  log/CSV/                the measurements, and .imported.json saying where
                          the copied-in ones came from
  tools/import_logs.py    bring earlier installs' logs into log/CSV/
  drivers/                the instrument drivers, as they came from cmms-web
  app/
    main.py               FastAPI app, CORS, static UI mount
    config.py             paths and tunables (env-overridable)
    monitor.py            the measurement loop; serial, remote and file devices
    series.py             ring buffers and min/max decimation
    csvlog.py             writing and reading the logs, both formats
    catalog.py            what each instrument measures and how
    portlock.py           which process already has a serial port open
    provenance.py         the "where did this come from" account
    units.py              conversions, and how to describe one
    drivers_bridge.py     the only import of drivers/
    schemas.py            request/response models
    net.py                which LAN URL to tell the operator to open
    routers/
      sources.py          mode, serial ports, instrument types
      profiles.py         the one list of what can be connected to
      devices.py          attach, close, provenance, series, raw samples
      logs.py             browse and plot the saved CSVs
      status.py           WebSocket broadcast of the latest readings
frontend/src/
  App.tsx                 shell, state-coloured tabs
  components/chart/       uPlot wrapper, gestures, range controls, the card
  components/             device, sources, logs, reference, provenance panels
  hooks/                  status socket, series windows, provenance
  lib/                    API client, formatting, palette, CSV parsing
```

## Environment

| | |
|---|---|
| `VACUUM_LOG_DIR` | where CSVs are written (default `backend/log`) |
| `VACUUM_DATA_DIR` | where `devices.json` lives |
| `VACUUM_POLL_INTERVAL` | seconds between reads (default 1) |
| `VACUUM_HISTORY_LIMIT` | samples held per channel (default 86400 = 24 h) |
| `VACUUM_BROADCAST_INTERVAL` | seconds between status pushes (default 0.5) |
| `VACUUM_REMOTE_URL` | the address offered when adding a remote profile |

Port **8002**, registered in `/home/cens-alpha-00/PORT_REGISTRY.md`.

## In the LILAK elog

This service answers the elog's service contract on **`POST /api/elog`** — the
same URL handles both the handshake (Discover) and every later data request.
`app/elog.py` holds it, with the field list at the top.

Register it once, in the elog's Experiment tab → New Service, with this URL:

```
portal://vacuum/api/elog
```

`portal://` rather than a host and port: a portal-managed service's port is
picked from a pool when it starts and can differ after a restart, so a literal
`http://127.0.0.1:<port>` goes stale. elog resolves the scheme per call from
`$PORTAL_DATA_ROOT/vacuum/.port` (`lilak_elog/backend/portal_peer.py`). Running
this service standalone instead, register its real address.

Press **Discover**: elog reads the field list back and builds a `"Vacuum Monitoring log"`
format from it. What it fills:

| | |
|---|---|
| `pressure` | the primary gauge's level in mbar, converted from whatever unit it reads in — an Infography metric |
| `gauge`, `log_file` | which gauge that was, and the CSV it is being written to |
| `body` | every open device, pressure and temperature alike |

One pressure field, not one per gauge: which gauges are plugged in is not
something a log format should depend on.

Two things about the field list. It is deliberately **fixed** — elog matches a
format by its field signature, so a list that changed with the hardware would
fork the format and last month's entries would stop lining up with this
month's. And elog gives up after **5 seconds**, with `mode: "realtime"`
repeating as often as twice a second, so the endpoint only ever reads state
this service already holds.
