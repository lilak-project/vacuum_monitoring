"""Unit conversion, and an honest account of what each conversion did.

The previous UI converted units in the browser and showed only the result, so
a number on screen could not be traced back to what the gauge actually said.
Here every conversion is a named factor the API can hand out alongside the
value, and the UI prints it.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Pressure units, each as the number of pascals in one of them.
#: Micron is the vacuum trade's name for a millitorr.
PRESSURE_IN_PASCAL: dict[str, float] = {
    "Pa": 1.0,
    "hPa": 100.0,
    "mbar": 100.0,
    "bar": 100_000.0,
    "Torr": 133.32236842105263,
    "mTorr": 0.13332236842105263,
    "Micron": 0.13332236842105263,
    "atm": 101_325.0,
    "psi": 6894.757293168361,
}

#: Offered in the UI, in the order a vacuum operator thinks of them.
PRESSURE_UNITS = ["Torr", "mbar", "Pa", "hPa", "Micron", "atm", "psi"]
TEMPERATURE_UNITS = ["K", "degC", "degF"]

#: What the gauges report when they will not say.
DEFAULT_UNIT = {"pressure": "Torr", "temperature": "K"}


def canonical_unit(unit: str | None, measure: str) -> str:
    """Map a driver's spelling of a unit onto the one the API uses."""
    text = (unit or "").strip()
    if not text:
        return DEFAULT_UNIT.get(measure, "")
    lowered = text.lower()
    if measure == "temperature":
        if lowered in ("k", "kelvin"):
            return "K"
        if lowered in ("c", "degc", "°c", "celsius"):
            return "degC"
        if lowered in ("f", "degf", "°f", "fahrenheit"):
            return "degF"
        return "K"
    for known in PRESSURE_IN_PASCAL:
        if known.lower() == lowered:
            return known
    return text


def units_for(measure: str) -> list[str]:
    return list(PRESSURE_UNITS if measure == "pressure" else TEMPERATURE_UNITS)


@dataclass(frozen=True)
class Conversion:
    """How a stored value becomes the value on screen.

    ``value_out = value_in * factor + offset``.  Both are carried through to
    the UI so a reading can be checked by hand -- pressure is a pure scaling,
    temperature is not.
    """

    factor: float
    offset: float

    @property
    def is_identity(self) -> bool:
        return self.factor == 1.0 and self.offset == 0.0

    def apply(self, value: float | None) -> float | None:
        return None if value is None else value * self.factor + self.offset

    def describe(self, source: str, target: str) -> str:
        if self.is_identity:
            return f"{target}, as read"
        if self.offset == 0.0:
            return f"{source} × {self.factor:.10g} → {target}"
        sign = "+" if self.offset >= 0 else "−"
        return f"({source} × {self.factor:.10g}) {sign} {abs(self.offset):.10g} → {target}"


def conversion(source: str, target: str, measure: str) -> Conversion:
    """The factor and offset taking `source` units to `target` units."""
    source = canonical_unit(source, measure)
    target = canonical_unit(target, measure)
    if source == target:
        return Conversion(1.0, 0.0)

    if measure == "temperature":
        # via kelvin
        to_k = {"K": (1.0, 0.0), "degC": (1.0, 273.15), "degF": (5.0 / 9.0, 459.67 * 5.0 / 9.0)}
        from_k = {"K": (1.0, 0.0), "degC": (1.0, -273.15), "degF": (9.0 / 5.0, -459.67)}
        if source not in to_k or target not in from_k:
            return Conversion(1.0, 0.0)
        f1, o1 = to_k[source]
        f2, o2 = from_k[target]
        return Conversion(f1 * f2, o1 * f2 + o2)

    try:
        return Conversion(PRESSURE_IN_PASCAL[source] / PRESSURE_IN_PASCAL[target], 0.0)
    except KeyError:
        # An unknown unit is shown unconverted rather than silently scaled.
        return Conversion(1.0, 0.0)


def convert(value: float | None, source: str, target: str, measure: str) -> float | None:
    return conversion(source, target, measure).apply(value)
