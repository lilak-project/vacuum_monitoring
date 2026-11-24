"""INFICON VGC401: one gauge, the same ACK/ENQ mnemonics as the TPG 36x.

Two differences from the TPG driver it borrows from: it opens any port (the
VGC is usually on a computer's own D-sub COM port, which has no USB id), and
it answers `AYT` with NAK, so `PR1` is what says it is there, asked once on open.
"""

from serial import Serial

from .tpg36x import TPG36X


class VGC401(TPG36X):
    def open(self):
        try:
            self.ser = Serial(self.port, 9600, timeout=1, write_timeout=1)
            self.ser.reset_input_buffer()
        except OSError:
            self.ser = None
            return
        try:
            alive = len(self.comm_pr1()) == 2
        except OSError:
            alive = False
        if not alive:
            self.ser.close()
            self.ser = None

    def is_open(self):
        # Asked before every poll, and each exchange with the VGC takes ~0.7 s,
        # so the PR1 check is done once in open(); a lost line reads as 0.
        return self.ser is not None

    def GetMeasure(self, i: int):
        return self.get_pr1() if self.ser else 0
