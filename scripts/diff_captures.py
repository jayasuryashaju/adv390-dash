"""Compare two captures taken before and after a change (for example, adding fuel) and list the fields that moved.
A field is kept when it is steady inside each capture and its typical value differs between them.

  python scripts/diff_captures.py before.csv after.csv
"""
import csv, collections, statistics, sys

COUNTER_IDS = set()  # nothing excluded; counters show up as drifting inside a capture and are dropped by the steadiness test


def medians(path):
    rd = csv.reader(open(path, newline=''))
    hdr = next(rd)
    ci, di = hdr.index('can_id'), hdr.index('data_hex')
    vals = collections.defaultdict(list)
    for r in rd:
        cid, d = int(r[ci], 16), bytes.fromhex(r[di].replace(' ', ''))
        for k in range(len(d)):
            vals[(cid, f'D{k}')].append(d[k])
            if k < len(d) - 1:
                vals[(cid, f'D{k}-D{k+1} BE')].append((d[k] << 8) | d[k + 1])
    return {k: (statistics.median(v), max(v) - min(v), len(v)) for k, v in vals.items() if len(v) >= 10}


a, b = medians(sys.argv[1]), medians(sys.argv[2])
rows = []
for key in a.keys() & b.keys():
    (ma, ra, _), (mb, rb, _) = a[key], b[key]
    full = 65535 if 'BE' in key[1] else 255
    steady = max(ra, rb) <= max(6, abs(mb - ma) * 0.5)  # moves less inside a capture than between them
    if mb != ma and steady:
        rows.append((abs(mb - ma) / full, key, ma, mb, ra, rb))
rows.sort(reverse=True)
print(f'{"ID":6} {"field":12} {"before":>8} {"after":>8} {"change":>8} {"noise":>10}')
for frac, (cid, fld), ma, mb, ra, rb in rows[:25]:
    print(f'0x{cid:03X}  {fld:12} {ma:8.0f} {mb:8.0f} {mb - ma:+8.0f} {max(ra, rb):10d}')
print('\nFuel should show as one field that rises when you add fuel, by about added litres / tank size of its full range.')
