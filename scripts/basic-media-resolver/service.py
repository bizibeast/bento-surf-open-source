"""Private, bounded public-video extraction. Credentials never enter responses/logs."""
import contextlib
import hmac
import html
import json
import math
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit, urljoin
from urllib.request import HTTPRedirectHandler, Request, build_opener

AUTH = os.environ.pop('INTERNAL_TOKEN', '')
COOKIE_JAR = os.environ.pop('YOUTUBE_COOKIE_JAR', '')
MAX_BYTES = 5 * 1024 ** 3
MAX_SECONDS = 24 * 60 * 60
JOBS = {}
LOCK = threading.Lock()


class Failure(Exception):
    def __init__(self, code):
        self.code = code


def source(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise Failure('error.api.link.invalid')
    p = urlsplit(value)
    if p.scheme != 'https' or p.username or p.password or p.port:
        raise Failure('error.api.link.invalid')
    if p.hostname in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'):
        vid = p.path.strip('/') if p.hostname == 'youtu.be' else parse_qs(p.query).get('v', [''])[0] if p.path == '/watch' else p.path.split('/')[2] if re.fullmatch(r'/(shorts|embed)/[^/]+/?', p.path) else ''
        if re.fullmatch(r'[A-Za-z0-9_-]{11}', vid):
            return 'youtube', vid, 'https://www.youtube.com/watch?v=' + vid
    if p.hostname in ('tiktok.com', 'www.tiktok.com', 'm.tiktok.com'):
        m = re.fullmatch(r'/@[A-Za-z0-9._-]{1,64}/video/(\d{8,24})/?', p.path)
        if m:
            return 'tiktok', m[1], 'https://www.tiktok.com' + p.path.rstrip('/')
    if p.hostname in ('vm.tiktok.com', 'vt.tiktok.com') and re.fullmatch(r'/[A-Za-z0-9_-]{5,64}/?', p.path):
        return 'tiktok', None, 'https://' + p.hostname + p.path
    raise Failure('error.api.link.invalid')


def media_url(platform, value):
    if not isinstance(value, str) or len(value) > 8192:
        raise Failure('error.api.fetch.fail')
    p = urlsplit(value)
    if p.scheme != 'https' or p.username or p.password or p.port or p.fragment:
        raise Failure('error.api.fetch.fail')
    host = p.hostname or ''
    if platform == 'youtube':
        allowed = host.endswith('.googlevideo.com') and p.path == '/videoplayback'
    else:
        allowed = any(host.endswith('.' + d) for d in ('tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com')) or (re.fullmatch(r'v\d{1,2}-webapp-prime(?:\.us)?\.tiktok\.com', host) and p.path.startswith('/video/'))
    if not allowed:
        raise Failure('error.api.fetch.fail')
    return value


def public_info(platform, expected, info):
    if info.get('_type', 'video') != 'video' or not re.fullmatch(r'[A-Za-z0-9_-]{11}' if platform == 'youtube' else r'\d{8,24}', str(info.get('id', ''))):
        raise Failure('error.api.content.unavailable')
    if expected and str(info['id']) != expected:
        raise Failure('error.api.content.unavailable')
    extractor = str(info.get('extractor_key', '')).lower()
    if extractor != ('youtube' if platform == 'youtube' else 'tiktok'):
        raise Failure('error.api.content.unavailable')
    if (platform == 'youtube' and info.get('availability') != 'public') or (platform == 'tiktok' and info.get('availability') not in (None, 'public')) or info.get('is_private') or info.get('is_unlisted') or info.get('age_limit', 0) or info.get('is_live') or info.get('is_upcoming'):
        raise Failure('error.api.content.video.private')
    duration = info.get('duration')
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise Failure('error.api.content.unavailable')
    if duration > MAX_SECONDS:
        raise Failure('error.api.content.too_long')


def choose(platform, info, mode, quality):
    formats = []
    for f in info.get('formats', [])[:200]:
        try:
            media_url(platform, f.get('url'))
        except (Failure, ValueError):
            continue
        if f.get('has_drm') or f.get('protocol') not in (None, 'https', 'http'):
            continue
        size = f.get('filesize') or f.get('filesize_approx') or 0
        if size and size > MAX_BYTES:
            continue
        formats.append(f)
    if platform == 'tiktok':
        # Some regions offer a higher-resolution video-only variant and the
        # backing song separately. Never pair that song with the source clip.
        formats = [f for f in formats if f.get('vcodec') not in (None, 'none') and f.get('acodec') not in (None, 'none')]
    def score(f):
        return (float(f.get('abr') or f.get('tbr') or 0), float(f.get('filesize') or 0))
    if mode == 'audio':
        if platform == 'tiktok':
            # TikTok's standalone audio format may be the full backing song.
            # Transcribe/export only audio attached to the actual source clip.
            formats = [f for f in formats if f.get('vcodec') not in (None, 'none')]
        audio = sorted((f for f in formats if f.get('acodec') not in (None, 'none')), key=lambda f: (f.get('vcodec') == 'none', score(f)), reverse=True)
        if audio:
            return [audio[0]]
    else:
        height = int(quality) if quality in ('360', '480', '720', '1080') else float('inf')
        def pixels(f):
            values = [float(f.get(k) or 0) for k in ('width', 'height')]
            return min(v for v in values if v > 0) if any(v > 0 for v in values) else 0
        videos = [f for f in formats if str(f.get('vcodec', '')).lower().startswith(('avc1', 'h264')) and 0 < pixels(f) <= height]
        if not videos and platform == 'tiktok':
            # The first-party download variant can omit dimensions. Native
            # download + FFprobe still validate actual video before it is served.
            videos = [f for f in formats if str(f.get('vcodec', '')).lower().startswith(('avc1', 'h264')) and pixels(f) == 0]
        videos.sort(key=lambda f: (pixels(f), float(f.get('tbr') or 0)), reverse=True)
        for video in videos:
            if video.get('acodec') not in (None, 'none'):
                return [video]
            audios = sorted((f for f in formats if f.get('vcodec') == 'none' and f.get('acodec') not in (None, 'none')), key=lambda f: (str(f.get('acodec')).startswith('mp4a'), score(f)), reverse=True)
            if audios:
                return [video, audios[0]]
    raise Failure('error.api.content.unavailable')


class Quiet:
    def debug(self, _): pass
    def warning(self, _): pass
    def error(self, _): pass


def tiktok_embed_info(video_id, page_url=None):
    # Read only the platform's public page and embed, with no login/cookie jar.
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args):raise Failure('error.api.tiktok.blocked')
    blocked = False
    for source in [page_url, 'https://www.tiktok.com/embed/v2/' + video_id]:
        if not source:continue
        try:
            with build_opener(NoRedirect()).open(Request(source, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html'}), timeout=8) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:continue
        except HTTPError as error:
            blocked = blocked or error.code in (401, 403, 429)
            continue
        for identity in ('__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE', '__NEXT_DATA__'):
            match = re.search(r'<script[^>]+id=["\']' + identity + r'["\'][^>]*>(.*?)</script>', raw.decode(errors='replace'), re.S)
            if not match:continue
            try:
                state = json.loads(html.unescape(match[1]))
                item = state.get('__DEFAULT_SCOPE__', {}).get('webapp.video-detail', {}).get('itemInfo', {}).get('itemStruct') or state.get('ItemModule', {}).get(video_id) or state.get('props', {}).get('pageProps', {}).get('itemInfo', {}).get('itemStruct')
                return tiktok_item_info(video_id, item)
            except (Failure, ValueError, AttributeError, TypeError):continue
    raise Failure('error.api.tiktok.blocked' if blocked else 'error.api.content.unavailable')


def tiktok_item_info(video_id, item):
    if not isinstance(item, dict) or str(item.get('id')) != video_id:raise Failure('error.api.content.unavailable')
    video = item.get('video') or {}
    formats = []
    for name in ('playAddr', 'downloadAddr'):
        address = video.get(name)
        urls = address.get('UrlList', address.get('urlList', [])) if isinstance(address, dict) else [address]
        for url in urls[:5]:
            if not isinstance(url, str):continue
            formats.append({'url': url, 'protocol': 'https', 'vcodec': 'h264', 'acodec': 'aac', 'width': video.get('width'), 'height': video.get('height')})
    return {'id': video_id, 'extractor_key': 'TikTok', 'duration': video.get('duration'), 'availability': 'public', 'formats': formats, 'http_headers': {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/'}}


def extract(value):
    import yt_dlp
    platform, expected, url = source(value.get('url'))
    mode = 'audio' if value.get('downloadMode') == 'audio' else 'video'
    quality = value.get('videoQuality', '720')
    if platform == 'tiktok' and expected:
        # Resolve a job, not a detached CDN URL. The native session checks public
        # identity and media before any response bytes are sent to the caller.
        return register_job(platform, expected, mode, [], native_source=url, quality=quality)
    with tempfile.TemporaryDirectory(prefix='media-auth-') as temp:
        options = {'compat_opts': {'no-certifi'}, 'quiet': True, 'no_warnings': True, 'logger': Quiet(), 'noplaylist': True, 'cachedir': False, 'socket_timeout': 8, 'retries': 1, 'extractor_retries': 1, 'fragment_retries': 1, 'js_runtimes': {'node': {'path': '/usr/local/bin/node'}}}
        if platform == 'youtube' and COOKIE_JAR:
            # Only YouTube-domain entries are allowed; never use this jar for TikTok.
            lines = []
            for raw in COOKIE_JAR.splitlines():
                line = raw.removeprefix('#HttpOnly_')
                if not line or line.startswith('#'):
                    continue
                fields = line.split('\t')
                if len(fields) != 7 or fields[0] not in ('.youtube.com', 'youtube.com', 'www.youtube.com') or fields[2] != '/' or any('\r' in f or '\x00' in f for f in fields):
                    raise Failure('error.api.youtube.login')
                lines.append(line)
            path = os.path.join(temp, 'cookies.txt')
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as out:
                out.write('# Netscape HTTP Cookie File\n' + '\n'.join(lines) + '\n')
            options['cookiefile'] = path
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as error:
            message = str(error).lower()
            if platform == 'tiktok' and expected:
                info = tiktok_embed_info(expected, url)
            else:
                raise Failure('error.api.youtube.login' if platform == 'youtube' and any(s in message for s in ('sign in', 'login', 'cookies', 'bot')) else 'error.api.fetch.fail') from None
        public_info(platform, expected, info)
        selected = choose(platform, info, mode, quality)
        inputs = []
        for f in selected:
            headers = {}
            for key, val in (f.get('http_headers') or info.get('http_headers') or {}).items():
                if key.lower() in ('user-agent', 'referer') and isinstance(val, str) and '\r' not in val and '\n' not in val:
                    headers[key] = val
            inputs.append({'url': media_url(platform, f['url']), 'headers': headers, 'acodec': str(f.get('acodec', ''))})
        return register_job(platform, info['id'], mode, inputs, **({'native_source': url, 'quality': quality} if platform == 'tiktok' else {}))


def register_job(platform, identity, mode, inputs, **native):
    job = secrets.token_hex(16)
    with LOCK:
        now = time.time()
        for key in list(JOBS):
            if JOBS[key]['expires'] < now:del JOBS[key]
        if len(JOBS) >= 20:raise Failure('error.api.basic_media.busy')
        JOBS[job] = {'platform': platform, 'mode': mode, 'inputs': inputs, 'expires': now + 100, **native}
    filename = platform + '-' + str(identity) + ('.mp3' if mode == 'audio' else '.mp4')
    return {'id': job, 'filename': filename, 'contentType': 'audio/mpeg' if mode == 'audio' else 'video/mp4'}


class SafeRedirect(HTTPRedirectHandler):
    def __init__(self, platform):
        self.platform = platform
        self.hops = 0
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.hops += 1
        if self.hops > 3:
            raise Failure('error.api.fetch.fail')
        media_url(self.platform, newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download_media(platform, item, out, remaining, deadline):
    url = media_url(platform, item['url'])
    received = 0
    failure = None
    def consume(data):
        nonlocal received, failure
        if received + len(data) > remaining:
            failure = Failure('error.api.content.too_large')
            return 0
        if time.monotonic() > deadline:
            failure = Failure('error.api.fetch.fail')
            return 0
        received += len(data)
        out.write(data)
        return len(data)
    if platform == 'tiktok':
        # A synchronous callback backpressures the socket on each disk write;
        # curl's background stream queue must not buffer a multi-gigabyte file.
        from curl_cffi import requests as browser
        with browser.Session(impersonate='chrome') as session:
            for hop in range(4):
                try:
                    response = session.get(url, headers=item['headers'], content_callback=consume, timeout=(8, 20), allow_redirects=False, verify=os.environ.get('SSL_CERT_FILE') or True)
                except Exception:
                    raise failure or Failure('error.api.fetch.fail') from None
                try:
                    if failure:raise failure
                    if response.status_code in (301, 302, 303, 307, 308):
                        if hop == 3:raise Failure('error.api.fetch.fail')
                        url = media_url(platform, urljoin(url, response.headers.get('location', '')))
                        out.seek(0);out.truncate()
                        continue
                    if response.status_code in (401, 403):raise Failure('error.api.tiktok.blocked')
                    if response.status_code == 429:raise Failure('error.api.rate_limit')
                    if response.status_code != 200:raise Failure('error.api.fetch.fail')
                    return received
                finally:response.close()
    else:
        with build_opener(SafeRedirect(platform)).open(Request(url, headers=item['headers']), timeout=12) as response:
            if response.status != 200 or int(response.headers.get('Content-Length', '0')) > remaining:
                raise Failure('error.api.fetch.fail')
            while data := response.read(65536):
                if consume(data) != len(data):raise failure
        return received
    raise Failure('error.api.fetch.fail')


def native_tiktok_input(job, folder):
    # Fresh child process: the Google jar and bridge token never enter its environment.
    import sys
    env = {k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','SSL_CERT_FILE','REQUESTS_CA_BUNDLE')}
    result = subprocess.run([sys.executable, str(Path(__file__).with_name('native_tiktok.py')), job['native_source'], folder, job['mode'], str(job['quality'])], capture_output=True, text=True, timeout=25 * 60, env=env)
    if result.returncode or len(result.stdout) > 4096:raise Failure('error.api.fetch.fail')
    data = json.loads(result.stdout)
    if data.get('error'):
        if isinstance(data.get('diagnostic'), dict):print(json.dumps({'event':'native_tiktok_failed', 'diagnostic':data['diagnostic']}), flush=True)
        raise Failure(data['error'] if data['error'] in ('error.api.tiktok.blocked','error.api.content.video.private','error.api.content.unavailable','error.api.content.too_large','error.api.content.too_long') else 'error.api.fetch.fail')
    name = data.get('filename', '')
    if name not in ('native.mp4','native.webm','native.mov'):raise Failure('error.api.fetch.fail')
    path = os.path.join(folder, name)
    if not 0 < os.path.getsize(path) <= MAX_BYTES:raise Failure('error.api.content.too_large')
    return path, str(data.get('acodec', ''))


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def reply(self, status, value):
        body = json.dumps(value).encode(); self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body)
    def authorized(self):
        return bool(AUTH) and hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + AUTH)
    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'ok': True})
        if not self.authorized():
            return self.reply(401, {'error': 'Unauthorized'})
        match = re.fullmatch(r'/stream/([a-f0-9]{32})', self.path)
        with LOCK:
            job = JOBS.get(match[1]) if match else None
        if not job or job['expires'] < time.time():
            return self.reply(404, {'error': 'Expired media'})
        self.stream(job)
    def do_POST(self):
        if self.path != '/resolve' or not self.authorized():
            return self.reply(401, {'error': 'Unauthorized'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 4096:
                raise Failure('error.api.link.invalid')
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise Failure('error.api.link.invalid')
            self.reply(200, extract(value))
        except Failure as error:
            self.reply(422, {'code': error.code})
        except Exception:
            self.reply(502, {'code': 'error.api.fetch.fail'})
    def stream(self, job):
        proc = None
        sent = False
        timer = None
        started = time.monotonic()
        phase = 'download'
        try:
            # MP4 headers can be at the end: use private seekable files, bounded in
            # aggregate, rather than handing a remote URL or nonseekable pipe to FFmpeg.
            with tempfile.TemporaryDirectory(prefix='media-input-') as temp:
                paths = []
                downloaded = 0
                if job.get('native_source'):
                    path, audio_codec = native_tiktok_input(job, temp)
                    paths.append(path)
                else:
                    for index, item in enumerate(job['inputs']):
                        path = os.path.join(temp, str(index) + '.media')
                        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        with os.fdopen(fd, 'wb') as out:
                            downloaded += download_media(job['platform'], item, out, MAX_BYTES - downloaded, started + 25 * 60)
                        paths.append(path)
                    audio_codec = job['inputs'][-1]['acodec']
                phase = 'mux'
                args = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error']
                for path in paths:
                    args += ['-protocol_whitelist', 'file,pipe', '-i', path]
                if job['mode'] == 'audio':
                    args += ['-vn', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1']
                else:
                    args += ['-map', '0:v:0', '-map', ('1:a:0' if len(paths) > 1 else '0:a:0'), '-c:v', 'copy', '-c:a', ('copy' if audio_codec.startswith(('mp4a', 'aac')) else 'aac'), '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']
                proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'LC_ALL')})
                def kill():
                    with contextlib.suppress(ProcessLookupError):proc.kill()
                timer = threading.Timer(max(1, 29 * 60 - (time.monotonic() - started)), kill)
                timer.start()
                prefix = proc.stdout.read(32)
                if not prefix or (job['mode'] == 'video' and prefix[4:8] != b'ftyp') or (job['mode'] == 'audio' and not (prefix.startswith(b'ID3') or prefix[:1] == b'\xff')):
                    raise Failure('error.api.fetch.fail')
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg' if job['mode'] == 'audio' else 'video/mp4')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Connection', 'close')
                self.end_headers()
                sent = True
                self.wfile.write(prefix)
                total = len(prefix)
                while data := proc.stdout.read(65536):
                    total += len(data)
                    if total > MAX_BYTES:raise Failure('error.api.content.too_large')
                    self.wfile.write(data)
                if proc.wait(timeout=2) != 0:raise Failure('error.api.fetch.fail')
        except Exception as error:
            code = error.code if isinstance(error, Failure) else 'error.api.fetch.fail'
            print(json.dumps({'event': 'public_media_transfer_failed', 'platform': job['platform'], 'phase': phase, 'code': code}), flush=True)
            if sent:
                with contextlib.suppress(Exception):self.connection.shutdown(2)
            else:self.reply(502, {'code': code, 'phase': phase})
        finally:
            if timer:timer.cancel()
            if proc and proc.poll() is None:
                with contextlib.suppress(ProcessLookupError):proc.kill()
            if proc:
                with contextlib.suppress(Exception):proc.wait(timeout=2)
                if proc.stdout:proc.stdout.close()
            self.close_connection = True


if __name__ == '__main__':
    if not AUTH:raise SystemExit('Missing service authentication')
    server = ThreadingHTTPServer(('0.0.0.0', 8080), Handler);server.daemon_threads = True;server.serve_forever()
