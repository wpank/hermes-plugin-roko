# Plan PQ-1 — pocket-sequencer: Turing Machine, quantizer, gates, pattern

**Goal**: a melodic personality in a pocket. A shift-register sequencer feeds a scale quantizer and a probability
gate, and a 16-step pattern prints as a dot-matrix grid.

**Adapted from**: bardo plan 08g (`golem-sonification` sequencers: TuringMachine, Quantizer with the Plutchik scale
map, ProbabilityGate, ClockDivider). This version stands alone: Python 3.11 standard library only, one call per clock
step instead of 32-sample blocks.

**Depends on**: `seq/__init__.py` (provided): `NOTE_NAMES` and `note_name(note)` (60 is `"C4"`).

---

## What to build

1. **`seq/turing.py`: `TuringMachine(length=16, change=0.0, scale=12.0, seed=0)`**
   - `length` 2..16, else `ValueError`; `change` clamped to 0..1. One `random.Random(seed)` drives everything:
     the register starts as its `getrandbits(16)`.
   - `step() -> (cv, gate)`: take the bit at position `length - 1` of `register` (bit 0 is the lowest); draw one
     `random()` per step and invert the bit when the draw is below `change`; then
     `register = ((register << 1) | bit) & 0xFFFF`.
   - So `change = 0.0` locks a loop of `length` steps, `0.5` mutates half the fed-back bits, and `1.0` inverts every
     fed-back bit, which locks a loop of `2 × length` steps.
   - `cv()` is the low 8 bits over 255 (0.0..1.0); `pitch()` is `cv() * scale` semitones; `step` returns `cv()` and
     `gate`, which is bit 15 of the register after the shift.

2. **`seq/quantize.py`: `SCALES`, `EMOTION_SCALES`, `Quantizer(scale="lydian", root=0, octave=0)`**
   - `SCALES` maps 12 names to pitch classes: lydian (0 2 4 6 7 9 11), major_pentatonic (0 2 4 7 9), phrygian
     (0 1 3 5 7 8 10), whole_tone (0 2 4 6 8 10), aeolian (0 2 3 5 7 8 10), japanese_in (0 1 5 7 8), harmonic_minor
     (0 2 3 5 7 8 11), dorian (0 2 3 5 7 9 10), ionian (0 2 4 5 7 9 11), mixolydian (0 2 4 5 7 9 10), chromatic (0..11),
     diminished (0 2 3 5 6 8 9 11).
   - `EMOTION_SCALES` is the Plutchik map, by index: joy lydian, trust major_pentatonic, fear phrygian, surprise
     whole_tone, sadness aeolian, disgust japanese_in, anger harmonic_minor, anticipation dorian.
   - `active` is the current set of pitch classes (relative to `root`). `quantize(pitch: float) -> int` returns the
     MIDI note nearest to `pitch` whose `(note - root) % 12` is in `active`; on a tie the lower note wins; then adds
     `12 * octave`. `process(pitch) -> (note, changed)`, where `changed` is true when the note differs from the
     previous call's (and on the first call).
   - Voice-led scale changes: `begin_scale_transition(name)` sets a target; each `advance_transition()` makes one
     change and returns `True`, or returns `False` once `active` equals the target. With `extras = active − target`
     and `missing = target − active` (each sorted): if both are non-empty, replace the lowest extra with the missing
     class nearest to it around the 12-note circle (ties: the lower class); else remove the lowest extra; else add
     the lowest missing class.

3. **`seq/gates.py`: `ProbabilityGate`, `ClockDivider`, `DIVISIONS`**
   - `ProbabilityGate(probability=0.5, seed=0)`: `process(trigger) -> bool`. A false trigger returns `False` without a
     draw; a true one draws `random()` from its own `random.Random(seed)` and passes when the draw is below
     `probability`.
   - `DIVISIONS = (2, 3, 4, 6, 8, 12, 16)`. `ClockDivider().process(clock: bool) -> dict[int, bool]`: counts
     **rising edges** (false to true); division `n` is true on the call of edges 1, n+1, 2n+1, … and false otherwise.
     A clock held high does not count again.

4. **`seq/pattern.py`: the 16-step pattern**
   - `render_pattern(seed=1, steps=16, scale="lydian", root=0, change=0.0, probability=0.75) -> list[int | None]`:
     a `TuringMachine(16, change, 24.0, seed)`, a `Quantizer(scale, root)` and a `ProbabilityGate(probability, seed)`.
     Each step: `step()` the machine, quantize `48 + pitch()`, and keep the note when the gate passes a true trigger,
     else `None`.
   - `format_pattern(pattern) -> str`: three lines, `step`, `gate` and `note`, each followed by one 3-wide
     right-aligned cell per step: the step number; `●` for a note and `·` for a rest; the note name or `-`.
   - `python3 -m seq.pattern [seed]` (default 1) prints `format_pattern(render_pattern(seed))`.

## Verification

The tests in `tests/` are the acceptance criteria. Change the code, never the tests.

| INV | Test | Constraint |
|---|---|---|
| INV-1 | `tests.test_turing.TuringMachineTest.test_locked_loop_repeats` | change 0.0: steps 16–31 equal steps 32–47 |
| INV-2 | `tests.test_turing.TuringMachineTest.test_length_sets_the_loop` | length 5 loops every 5 steps and is not constant |
| INV-3 | `tests.test_turing.TuringMachineTest.test_half_change_mutates` | change 0.5: two successive cycles differ |
| INV-4 | `tests.test_turing.TuringMachineTest.test_full_change_inverts` | change 1.0, length 8: repeats after 16 steps, not after 8 |
| INV-5 | `tests.test_quantize.QuantizerTest.test_lydian_snaps` | every output of C Lydian is in {0 2 4 6 7 9 11} mod 12 |
| INV-6 | `tests.test_quantize.QuantizerTest.test_nearest_note_ties_go_down` | nearest note; 5.0 gives 4 |
| INV-7 | `tests.test_quantize.QuantizerTest.test_transition_changes_one_note_per_call` | Lydian to Phrygian: 5 calls, one note out and one in each |
| INV-8 | `tests.test_gates.ProbabilityGateTest.test_zero_*`, `test_one_*` | probability 0: 0 of 100 pass; probability 1: 100 of 100 |
| INV-9 | `tests.test_gates.ClockDividerTest.test_div4_fires_once_per_four_pulses` | 12 pulses held 3 calls each: div4 fires 3 times |
| INV-10 | `tests.test_pattern.PatternTest.test_pattern_*` | 16 steps, notes in scale and in 48..72, deterministic by seed |
| INV-11 | `tests.test_pattern.PatternTest.test_format`, `test_cli` | three rows, 16 cells; the CLI prints the same grid |

## Non-goals

- MarkovMelody, BeadsGateGen and ClockJitter from 08g; audio output.
- Changing `seq/__init__.py` or anything under `tests/`.
