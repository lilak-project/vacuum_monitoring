"""What each device type actually measures, and how the number is arrived at.

This is the file behind the "where does this number come from" panel. Nothing
here talks to hardware -- it is the written-down reading of `drivers/`, kept
beside it so the UI can say, of any point on any chart, which instrument it
came from, which channel of it, what the driver asked for, and what arithmetic
turned the reply into the value on screen.

Keep an entry in step with its driver. If the two ever disagree the driver is
right and this file is a bug.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .units import DEFAULT_UNIT


@dataclass(frozen=True)
class ChannelSpec:
    """One measurement a device offers."""

    label: str
    #: The driver call the value comes from, written as it appears in the code.
    call: str
    #: What the device is asked, on the wire.
    query: str = ""


@dataclass(frozen=True)
class DeviceSpec:
    name: str
    #: What it is, in the words someone at the bench would use.
    title: str
    measure: str  # "pressure" | "temperature"
    channels: list[ChannelSpec]
    #: Serial line settings the driver opens with.
    link: str
    #: How the reply becomes a number, in one line of arithmetic or prose.
    arithmetic: str
    #: Where the unit on the value comes from -- the device, or an assumption.
    unit_note: str
    #: USB vendor:product the driver matches on, when it matches on one.
    usb_id: str = ""
    #: Anything an operator would otherwise have to read the driver to learn.
    caveats: list[str] = field(default_factory=list)
    #: True for the fake devices, which read no hardware at all.
    simulated: bool = False

    @property
    def channel_count(self) -> int:
        return len(self.channels)

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "title": self.title,
            "measure": self.measure,
            "channel_count": self.channel_count,
            "channels": [
                {"index": i, "label": c.label, "call": c.call, "query": c.query}
                for i, c in enumerate(self.channels)
            ],
            "link": self.link,
            "arithmetic": self.arithmetic,
            "unit_note": self.unit_note,
            "usb_id": self.usb_id,
            "caveats": list(self.caveats),
            "simulated": self.simulated,
            "default_unit": DEFAULT_UNIT.get(self.measure, ""),
        }


CATALOG: dict[str, DeviceSpec] = {
    "BCG450": DeviceSpec(
        name="BCG450",
        title="INFICON BCG450 — Pirani / Bayard-Alpert / piezo combination gauge",
        measure="pressure",
        channels=[ChannelSpec("Pressure", "BCG450.get_pr()", "reads the free-running 18-byte frame")],
        link="RS-232 over a PL2303 USB adapter, pyserial defaults (9600 8N1), 1 s read timeout",
        arithmetic=(
            "The gauge streams a 9-byte frame starting 0x07 0x05. Bytes 4 and 5 are a "
            "big-endian measurement word; pressure = 10^((b4·256 + b5) / 4000 − k), "
            "where k is 12.5 for mbar, 12.625 for Torr and 10.5 for Pa. The frame is "
            "accepted only when its checksum (sum of bytes 1..7 mod 256) matches byte 8."
        ),
        unit_note="Read from the gauge: bits 4–5 of status byte 2 select mbar, Torr or Pa.",
        usb_id="067B:2303 (Prolific PL2303)",
        caveats=[
            "The gauge talks continuously and is never asked anything; the driver "
            "flushes the input buffer and takes the next whole frame.",
            "A frame that does not checksum yields NaN, which is dropped rather than plotted.",
        ],
    ),
    "TPG36X": DeviceSpec(
        name="TPG36X",
        title="Pfeiffer TPG 361/362 — dual gauge controller",
        measure="pressure",
        channels=[
            ChannelSpec("Gauge 1", "TPG36X.get_pr1()", "PR1"),
            ChannelSpec("Gauge 2", "TPG36X.get_pr2()", "PR2"),
        ],
        link="RS-232 over an FTDI adapter, pyserial defaults (9600 8N1), 1 s timeout",
        arithmetic=(
            "Mnemonic protocol: the command is sent, the controller ACKs, an ENQ then "
            "fetches the reply. `PR1` answers `<status>,<pressure>` and the second "
            "field is taken as a float."
        ),
        unit_note="Read from the controller with `UNI`: 0 mbar, 1 Torr, 2 Pa, 3 Micron, 4 hPa, 5 Volt.",
        usb_id="0403:6001 (FTDI FT232)",
        caveats=[
            "A non-zero status field is a gauge fault (under/over range, sensor off, "
            "no sensor). The driver returns the pressure field regardless, so a "
            "reading of 0 usually means the gauge is off rather than at zero pressure.",
            "Both gauges share one serial line, so channel 2 is read a moment after channel 1.",
        ],
    ),
    "VGC401": DeviceSpec(
        name="VGC401",
        title="INFICON VGC401 — single gauge controller",
        measure="pressure",
        channels=[ChannelSpec("Gauge", "VGC401.get_pr1()", "PR1")],
        link="RS-232 on the rear D-sub (not CONTROL), 9600 8N1, 1 s timeout; any port, often a built-in /dev/ttyS*",
        arithmetic=(
            "The TPG mnemonic protocol: `PR1`, ACK, then ENQ fetches `<status>,<pressure>` "
            "and the second field is taken as a float."
        ),
        unit_note="Read from the controller with `UNI`: 0 mbar, 1 Torr, 2 Pa, 3 Micron.",
        caveats=[
            "A non-zero status field is a gauge fault (under/over range, sensor off, "
            "no sensor); the pressure field is returned regardless.",
            "It answers `AYT` with NAK, so the driver checks it is there with `PR1` instead.",
        ],
    ),
    "TIC100": DeviceSpec(
        name="TIC100",
        title="Edwards TIC — turbo instrument controller, three gauge inputs",
        measure="pressure",
        channels=[
            ChannelSpec("Gauge 1", "TIC100.gauge_queryv(1)", "?V913"),
            ChannelSpec("Gauge 2", "TIC100.gauge_queryv(2)", "?V914"),
            ChannelSpec("Gauge 3", "TIC100.gauge_queryv(3)", "?V915"),
        ],
        link="RS-232 over a USB adapter, pyserial defaults (9600 8N1), 1 s timeout",
        arithmetic=(
            "`?V902` first, to learn which gauge inputs are populated. Then `?V91n` "
            "answers `<pressure>;<unit>;<state>` and the first field is taken as a float."
        ),
        unit_note="Not read from the controller — the driver reports Pa, which is what the TIC is set to.",
        usb_id="0403:6001 (FTDI FT232) — shared with the TPG, so the port matters",
        caveats=[
            "An input reported as unpopulated by `?V902` reads 0 rather than being skipped.",
            "The unit is assumed, not queried. If the controller is switched to mbar "
            "the numbers here will be wrong by a factor of 100.",
        ],
    ),
    "LS218": DeviceSpec(
        name="LS218",
        title="Lake Shore 218 — eight-channel cryogenic temperature monitor",
        measure="temperature",
        channels=[
            ChannelSpec(f"Sensor {n}", f"LS218.get_temp('{n}')", f"KRDG? {n}") for n in range(1, 9)
        ],
        link="RS-232 over an FTDI adapter, 9600 baud, 7 data bits, odd parity, 1 stop bit",
        arithmetic="`KRDG? n` answers the channel's temperature in kelvin as a float. No arithmetic is applied.",
        unit_note="Fixed at kelvin: the driver asks for `KRDG?`, which is the kelvin reading.",
        usb_id="0403:6001 (FTDI FT232)",
        caveats=[
            "All eight channels are polled every cycle, one query each, so a full "
            "sweep is eight round trips on a 9600-baud line.",
            "A disconnected or faulted sensor still answers, typically with 0 — "
            "`RDGST?` would say why, and the driver does not ask.",
        ],
    ),
    "M1": DeviceSpec(
        name="M1",
        title="Simulated single-channel pressure gauge",
        measure="pressure",
        channels=[ChannelSpec("Pressure", "M1.GetMeasure(0)")],
        link="none — nothing is opened",
        arithmetic="A counter that increases by one on every read.",
        unit_note="Reported as Torr, so the pressure formatting can be exercised.",
        caveats=["Reads no hardware. For trying the UI out when the bench is not available."],
        simulated=True,
    ),
    "M2": DeviceSpec(
        name="M2",
        title="Simulated three-channel thermometer",
        measure="temperature",
        channels=[ChannelSpec(f"Sensor {n}", f"M2.GetMeasure({n - 1})") for n in range(1, 4)],
        link="none — nothing is opened",
        arithmetic="A counter that increases by one on every read; all three channels share it.",
        unit_note="Reported as kelvin.",
        caveats=["Reads no hardware. For trying the UI out when the bench is not available."],
        simulated=True,
    ),
}


def spec(device_type: str) -> DeviceSpec | None:
    return CATALOG.get(device_type)


def channel_label(device_type: str, index: int) -> str:
    """Name of one channel, falling back to a number for an unknown device."""
    found = CATALOG.get(device_type)
    if found is not None and 0 <= index < len(found.channels):
        return found.channels[index].label
    return f"CH{index + 1}"


def measure_of(device_type: str, default: str = "pressure") -> str:
    found = CATALOG.get(device_type)
    return found.measure if found is not None else default


#: Which device type a serial port most likely belongs to, by USB vendor:product.
#: The FTDI id is shared by three of them, so it offers all three rather than
#: guessing -- the operator knows which box is on which port and the UI asks.
USB_HINTS: dict[tuple[int, int], list[str]] = {
    (0x067B, 0x2303): ["BCG450"],
    (0x0403, 0x6001): ["TPG36X", "LS218", "TIC100"],
}


def suggest_types(vid: int | None, pid: int | None) -> list[str]:
    if vid is None or pid is None:
        return []
    return list(USB_HINTS.get((vid, pid), []))
