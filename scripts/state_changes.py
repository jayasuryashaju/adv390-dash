"""List bytes on unknown CAN IDs that change only a few times: settings and switches, not live values.
Usage: python scripts/state_changes.py capture.csv [more.csv ...]   (CSV exported from the Bus view)"""
import csv, sys, collections
KNOWN = {0x120, 0x128, 0x129, 0x12A, 0x12D, 0x12E, 0x12F, 0x290, 0x450, 0x540, 0x55A}

for path in sys.argv[1:]:
    last, changes = {}, collections.defaultdict(list)
    for row in csv.reader(open(path, newline='')):
        if not row or row[0] == 'host_s': continue
        t, cid, data = float(row[0]), int(row[2], 16), bytes.fromhex(row[3].replace(' ', ''))
        if cid in KNOWN: continue
        for k, (a, b) in enumerate(zip(last.get(cid, data), data)):
            if a != b: changes[(cid, k)].append((t, a, b))
        last[cid] = data
    print(f'== {path}')
    for (cid, k), v in sorted(changes.items()):
        if len(v) <= 12:
            print(f'  0x{cid:03X} D{k}  {len(v):2d} changes: ' + '  '.join(f'{t:6.1f}s {a:02X}>{b:02X}' for t, a, b in v))
