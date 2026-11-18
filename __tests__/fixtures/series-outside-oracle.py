# Independent RFC 5545 truth for __tests__/fixtures/series-outside-cases.json:
# does an occurrence of the series touch the range? Computed with
# python-dateutil (not ical.js, not tsdav-utils), written back as `touches`.
#
#   python3 __tests__/fixtures/series-outside-oracle.py   (python-dateutil 2.9)
#
# A case dateutil cannot judge (RSCALE, a rule RFC 5545 forbids) keeps
# `touches: null`; the test asks only that such a series is not ruled out.
import json, os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from dateutil.rrule import rrulestr

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, 'series-outside-cases.json')
FLOATING = timezone.utc  # the test reads floating times and dates in UTC


def parse(value, tz):
    """'20200106T090000Z' | '20200106T090000' | '20200106' -> aware datetime"""
    zone = timezone.utc if value.endswith('Z') else (ZoneInfo(tz) if tz else FLOATING)
    value = value.rstrip('Z')
    fmt = '%Y%m%dT%H%M%S' if 'T' in value else '%Y%m%d'
    return datetime.strptime(value, fmt).replace(tzinfo=zone)


def touches(case):
    lo = datetime.fromisoformat(case['range'][0].replace('Z', '+00:00'))
    hi = datetime.fromisoformat(case['range'][1].replace('Z', '+00:00'))
    hit = lambda s, e: s < hi and (e > lo or s >= lo)
    tz = case.get('tzid')
    start = parse(case['dtstart'], tz)
    length = timedelta(seconds=case['duration'])
    moved = {parse(o['rid'], tz) for o in case.get('overrides', [])}
    for o in case.get('overrides', []):
        if hit(parse(o['start'], tz), parse(o['end'], tz)):
            return True
    for p in case.get('rdatePeriods', []):
        if hit(parse(p[0], tz), parse(p[1], tz)):
            return True
    # dateutil wants naive wall clocks for a zoned start
    naive = start.replace(tzinfo=None)
    rule = rrulestr(case['rrule'], dtstart=naive)
    # every instance that could reach the range, read on the series' wall clock
    window_lo = (lo - length - timedelta(days=2)).astimezone(start.tzinfo).replace(tzinfo=None)
    window_hi = (hi + timedelta(days=2)).astimezone(start.tzinfo).replace(tzinfo=None)
    starts = set(rule.between(window_lo, window_hi, inc=True))
    if window_lo <= naive <= window_hi:
        starts.add(naive)  # DTSTART is always an instance
    for wall in starts:
        s = wall.replace(tzinfo=start.tzinfo)
        if s in moved:
            continue
        if hit(s, s + length):
            return True
    return False


cases = json.load(open(PATH))
for case in cases:
    if case.get('oracle') is False:
        case['touches'] = None
        continue
    case['touches'] = touches(case)
json.dump(cases, open(PATH, 'w'), indent=1)
print('\n'.join(f"{c['touches']!s:5} {c['name']}" for c in cases))
