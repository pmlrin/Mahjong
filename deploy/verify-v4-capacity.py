#!/usr/bin/env python3
"""Server-only capacity harness. Run the load generator on another machine.
Requires a disposable capacity DB, a cgroup memory cap and OOMScoreAdjust>=900.
The startup/headroom guard stops this test before other services lose memory.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit

config = json.load(open(sys.argv[1]))
stop_requested = False
def stop_gracefully(_signal, _frame):
    global stop_requested
    stop_requested = True
signal.signal(signal.SIGTERM, stop_gracefully)
case = sys.argv[2]
assert case in ['1', '4']
work = os.path.dirname(os.path.abspath(sys.argv[1]))
assert int(open('/proc/self/oom_score_adj').read().strip()) >= 900
url = urlsplit(config['databases'][case])
assert url.hostname in ['localhost', '127.0.0.1']
assert re.match(r'^/mahjong_v4_capacity_20261101_[14]$', url.path)
def available():
    for line in open('/proc/meminfo'):
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) / 1024
    raise RuntimeError('Memory headroom is unavailable')
assert available() >= 450, 'Insufficient safe memory headroom for this test'
env = os.environ.copy()
env.update(config['base'])
env['DATABASE_URL'] = config['databases'][case]
env['ALLOW_ISOLATED_SEED'] = 'YES'
env['LOAD_AUTH_LOAD'] = '0'
env['LOAD_SOCIAL_LOAD'] = '1'
env['LOAD_FIXTURE'] = work + '/fixture-' + case + '.json'
node = '/opt/mahjong/runtime/bin/node'
release = config['release']
subprocess.check_call([node, release + '/dist-server/backend/src/load-v2.mjs', '--reset'], cwd=release, env=env)
report = {'case':case, 'serverOnly':True, 'headroomStartMiB':available(), 'samples':[], 'abortedForMemory':False}
server = None
try:
    with open(work + '/bounded-server-' + case + '.log','w') as log:
        server = subprocess.Popen([node,'--max-old-space-size=112',release+'/dist-server/backend/src/server.js'],cwd=release,env=env,stdout=log,stderr=subprocess.STDOUT)
        started = time.monotonic()
        last_cpu = None
        last_at = started
        while time.monotonic() - started < 900:
            memory = available()
            if memory < 200:
                report['abortedForMemory'] = True
                raise RuntimeError('Safe memory headroom exhausted; stopping test')
            if server.poll() is not None:
                report['serverExitBeforeStop'] = server.returncode
                raise RuntimeError('Capacity server exited')
            if stop_requested or os.path.exists(work+'/stop-'+case):
                break
            rss = None
            for line in open('/proc/%s/status' % server.pid):
                if line.startswith('VmRSS:'):
                    rss = int(line.split()[1]) / 1024
            now = time.monotonic()
            fields = open('/proc/%s/stat' % server.pid).read().split()
            ticks = int(fields[13]) + int(fields[14])
            cpu = None if last_cpu is None else (ticks-last_cpu)/os.sysconf('SC_CLK_TCK')/(now-last_at)*100
            last_cpu = ticks
            last_at = now
            report['samples'].append({'elapsed':now-started,'availableMiB':memory,'rssMiB':rss,'cpuPercent':cpu})
            if len(report['samples']) % 10 == 0:
                with open(work+'/bounded-report-'+case+'.json','w') as out:
                    json.dump({**report, 'finished':False},out)
            with open(work+'/bounded-status-'+case+'.json','w') as out:
                json.dump({'running':True,'elapsedSeconds':time.monotonic()-started,'availableMiB':memory,'rssMiB':rss,'pid':server.pid},out)
            time.sleep(1)
finally:
    if server is not None and server.poll() is None:
        server.terminate()
        try:server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill();server.wait()
    report['headroomEndMiB'] = available()
    report['finished'] = True
    with open(work+'/bounded-report-'+case+'.json','w') as out:
        json.dump(report,out,indent=2)
