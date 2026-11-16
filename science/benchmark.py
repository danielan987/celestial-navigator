"""Measure live status/asset transfers and cache latency; never removes source data."""
import argparse
import gzip
import json
import statistics
import time
import urllib.request


def request(url, gzip_ok=False):
    started = time.perf_counter()
    req = urllib.request.Request(url, headers={'Accept-Encoding': 'gzip' if gzip_ok else 'identity'})
    with urllib.request.urlopen(req) as response:
        wire = response.read()
        body = gzip.decompress(wire) if response.headers.get('Content-Encoding') == 'gzip' else wire
        return body, dict(wireBytes=len(wire), decodedBytes=len(body), ms=round((time.perf_counter()-started)*1000, 3))


def benchmark(base, target):
    status_url = f'{base}/science/extract?target={target}&z=0&radius=30'
    started = time.perf_counter()
    while True:
        body, _ = request(status_url)
        status = json.loads(body)
        if status['status'] == 'error':
            raise RuntimeError(status.get('error'))
        if status['status'] == 'ready':
            break
        if time.perf_counter() - started > 600:
            raise TimeoutError('Processing did not finish in 10 minutes')
        time.sleep(.2)
    completion_wait = round((time.perf_counter()-started)*1000, 3)
    polls = [request(status_url)[1] for _ in range(5)]
    body, metadata_stats = request(base + status['resultUrl'], gzip_ok=True)
    manifest = json.loads(body)
    assets = [feature['array']['url'] for feature in manifest['maps']]
    if manifest['medianArray']:
        assets.append(manifest['medianArray']['url'])
    if manifest['galex']:
        assets.append(manifest['galex']['array']['url'])
    arrays = {url: request(base+url, gzip_ok=True)[1] for url in set(assets)}
    return dict(target=target, conditions='local HTTP; completed job, existing upstream cache; five status requests',
                completionWaitMs=completion_wait, benchmarkTotalMs=round((time.perf_counter()-started)*1000, 3),
                statusBytes=polls[0]['wireBytes'], statusMedianMs=statistics.median(row['ms'] for row in polls),
                metadata=metadata_stats, arrays=arrays,
                totalResultWireBytes=metadata_stats['wireBytes']+sum(row['wireBytes'] for row in arrays.values()),
                processing=status.get('metrics', {}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='http://127.0.0.1:8001')
    parser.add_argument('--target', default='m101')
    parser.add_argument('--output')
    args = parser.parse_args()
    result = benchmark(args.base, args.target)
    output = json.dumps(result, indent=2)
    if args.output:
        from pathlib import Path
        Path(args.output).write_text(output)
    print(output)
