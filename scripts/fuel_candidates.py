"""List slow-moving byte and 16-bit fields in a capture: fuel level candidates.
Usage: python scripts/fuel_candidates.py capture.csv [expected_fraction]   (expected_fraction default 0.45)"""
import csv, sys, statistics, collections

path = sys.argv[1]
frac = float(sys.argv[2]) if len(sys.argv) > 2 else 0.45
data = collections.defaultdict(list)
for r in csv.reader(open(path, newline='')):
    if not r or r[0] == 'host_s': continue
    d = bytes.fromhex(r[3].replace(' ', ''))
    data[int(r[2], 16)].append((float(r[0]), d))

rows = []
for cid, frames in data.items():
    n = len(frames)
    for k in range(8):
        for width, name in ((1, f'D{k}'), (2, f'D{k}-D{k+1} BE'), (3, f'D{k}-D{k+2} u24 BE')) if k < 6 else ((1, f'D{k}'), (2, f'D{k}-D{k+1} BE')) if k < 7 else ((1, f'D{k}'),):
            vals = [int.from_bytes(d[k:k + width], 'big') for _, d in frames if len(d) >= k + width]
            if len(vals) < 20: continue
            distinct = len(set(vals)); top = collections.Counter(vals).most_common(1)[0][1] / len(vals)
            changes = sum(a != b for a, b in zip(vals, vals[1:]))
            mx = (1 << (8 * width)) - 1
            med = statistics.median(vals)
            # slow: few transitions; not a counter: bounded distinct values
            if 2 <= distinct <= 80 and changes < n * 0.25:
                rows.append((cid, name, med, min(vals), max(vals), distinct, changes, med / mx))
print(f'{path}: slow fields (few transitions). Looking for about {frac:.0%} of full scale, or a value near {frac*100:.0f} / {frac*255:.0f} / {frac*14.5:.1f} L.')
print(f'{"ID":6} {"field":18} {"median":>8} {"min":>8} {"max":>8} {"distinct":>8} {"changes":>8} {"of full":>8}')
for cid, name, med, lo, hi, dist, ch, f in sorted(rows):
    mark = '  <-- plausible' if abs(f - frac) < 0.12 or abs(med - frac * 100) < 6 or abs(med - frac * 14.5 * 10) < 12 else ''
    print(f'0x{cid:03X}  {name:18} {med:8.0f} {lo:8d} {hi:8d} {dist:8d} {ch:8d} {f:8.2f}{mark}')
