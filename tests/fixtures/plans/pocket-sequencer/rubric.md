## Shared Review Rubric — pocket-sequencer

### Tests
- [ ] `python3 -m unittest discover -s tests -t .` — zero failures

### Invariants
- [ ] TuringMachine feeds back bit `length - 1`; change 1.0 inverts it
- [ ] Quantizer ties go to the lower note; a transition swaps one note per call
- [ ] ClockDivider counts rising edges only
