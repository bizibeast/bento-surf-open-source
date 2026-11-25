"""Private, bounded public-video extraction. Credentials never enter responses/logs."""
import contextlib
import hmac
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import signal
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit, urljoin
from urllib.request import HTTPRedirectHandler, Request, build_opener

AUTH = os.environ.pop('INTERNAL_TOKEN', '')
SERVICE_REVISION = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
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
    if item.get('privateItem') or item.get('isSecret') or (item.get('author') or {}).get('privateAccount'):raise Failure('error.api.content.video.private')
    video = item.get('video') or {}
    formats = []
    for name in ('playAddr', 'downloadAddr'):
        address = video.get(name)
        urls = address.get('UrlList', address.get('urlList', [])) if isinstance(address, dict) else [address]
        for url in urls[:5]:
            if not isinstance(url, str):continue
            formats.append({'url': url, 'protocol': 'https', 'vcodec': 'h264', 'acodec': 'aac', 'width': video.get('width'), 'height': video.get('height')})
    stats = item.get('statsV2') or item.get('stats') or {}
    counters = {key: int(stats[field]) for key, field in [('view_count','playCount'),('like_count','diggCount'),('comment_count','commentCount'),('repost_count','shareCount'),('save_count','collectCount')] if isinstance(stats.get(field),(int,str)) and not isinstance(stats.get(field),bool) and re.fullmatch(r'\d+',str(stats[field]))}
    return {'id': video_id, 'extractor_key': 'TikTok', 'duration': video.get('duration'), 'availability': 'public', 'formats': formats, 'http_headers': {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/'}, **counters}


def extraction_options(platform, temp, statistics=False):
    options = {'compat_opts': {'no-certifi'}, 'quiet': True, 'no_warnings': True, 'logger': Quiet(), 'noplaylist': True, 'cachedir': False, 'socket_timeout': 8, 'retries': 1, 'extractor_retries': 1, 'fragment_retries': 1, 'js_runtimes': {'node': {'path': '/usr/local/bin/node'}}}
    if platform == 'youtube' and COOKIE_JAR and not statistics:
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
    if statistics:
        options.update({"skip_download": True, "ignore_no_formats_error": True, "retries": 0, "extractor_retries": 0, "fragment_retries": 0})
        if platform == 'youtube':
            # Counters need neither playback manifests nor JavaScript signature
            # solving. Avoid CDN reads entirely instead of widening the guard.
            options['extractor_args'] = {'youtube': {'skip': ['hls', 'dash'], 'player_skip': ['js']}}
    return options


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
        options = extraction_options(platform, temp)
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


def statistics_source(url):
    try:return source(url)
    except Failure:pass
    if not isinstance(url, str) or len(url) > 2048:raise Failure('error.api.link.invalid')
    p = urlsplit(url)
    if p.scheme != 'https' or p.username or p.password or p.port or p.hostname not in ('www.facebook.com','facebook.com','m.facebook.com'):raise Failure('error.api.link.invalid')
    match = re.fullmatch(r'/(?:reel|[A-Za-z0-9._-]+/videos)/(\d{1,24})/?',p.path)
    identity = match[1] if match else parse_qs(p.query).get('v',[''])[0] if p.path.rstrip('/') == '/watch' else ''
    if not re.fullmatch(r'\d{1,24}',identity):raise Failure('error.api.link.invalid')
    return 'facebook',identity,'https://www.facebook.com/watch?v='+identity


def statistics_info(platform, expected, info):
    if not isinstance(info, dict) or str(info.get('id', '')) != str(expected):
        raise Failure('error.api.content.unavailable')
    extractor = str(info.get('extractor_key', '')).lower()
    if extractor != platform and not (platform == 'facebook' and extractor.startswith('facebook')):
        raise Failure('error.api.content.unavailable')
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}' if platform == 'youtube' else r'\d{1,24}', str(info.get('id', ''))):
        raise Failure('error.api.content.unavailable')
    if (platform == 'youtube' and info.get('availability') != 'public') or info.get('availability') not in (None, 'public') or info.get('is_private') or info.get('is_unlisted') or info.get('age_limit', 0):
        raise Failure('error.api.content.video.private')
    counts = {}
    for output, field in [('views', 'view_count'), ('likes', 'like_count'), ('comments', 'comment_count'), ('shares' if platform in ('tiktok','facebook') else 'reposts', 'repost_count'), ('saves', 'save_count')]:
        value = info.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 and int(value) == value and value <= 9007199254740991:
            counts[output] = int(value)
    return {'platform': platform, 'id': str(info['id']), 'counts': counts}


def extract_statistics(url, folder):
    import yt_dlp
    platform, expected, canonical = statistics_source(url)
    options = extraction_options(platform, folder, statistics=True)
    with yt_dlp.YoutubeDL(options) as ydl:
        original = ydl.urlopen
        requests = 0
        def guarded(req):
            nonlocal requests
            requests += 1
            target = req if isinstance(req, str) else req.url
            parsed = urlsplit(target)
            host = parsed.hostname or ''
            domains = ('youtube.com', 'youtu.be', 'youtube-nocookie.com', 'ytimg.com', 'googleapis.com') if platform == 'youtube' else ('facebook.com','facebook.net','fbcdn.net') if platform == 'facebook' else ('tiktok.com', 'tiktokv.com', 'tiktokapis.com')
            if requests > 16 or parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443) or not any(host == d or host.endswith('.' + d) for d in domains):
                raise Failure('error.api.fetch.fail')
            response = original(req)
            final = urlsplit(response.url)
            if final.scheme != 'https' or final.username or final.password or not any(final.hostname == d or (final.hostname or '').endswith('.' + d) for d in domains):
                response.close()
                raise Failure('error.api.fetch.fail')
            return response
        ydl.urlopen = guarded
        try:info = ydl.extract_info(canonical, download=False)
        except Exception as error:
            if platform == 'youtube':
                message = str(error).lower()
                raise Failure('error.api.youtube.login' if any(s in message for s in ('sign in', 'login', 'cookies', 'bot')) else 'error.api.youtube.metadata') from None
            if platform != 'tiktok' or not expected:raise
            info = tiktok_embed_info(expected, canonical)
    return statistics_info(platform, expected or info.get('id'), info)


def statistics(value):
    platform, _, canonical = statistics_source(value.get('url'))
    with tempfile.TemporaryDirectory(prefix='metadata-only-') as folder:
        payload = {'url': canonical, 'directory': folder, 'cookieJar': ''}
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE')}
        proc = subprocess.Popen([sys.executable, str(Path(__file__)), '--stats-child'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env, start_new_session=True)
        try:
            out, _ = proc.communicate(json.dumps(payload), timeout=38)
            if proc.returncode:
                raise Failure('error.api.metadata.child_exit')
            if len(out.encode()) > 8192:
                raise Failure('error.api.metadata.child_output')
            result = json.loads(out)
            if result.get('error'):
                raise Failure(result['error'])
            return result
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            raise Failure('error.api.fetch.fail') from None
        finally:
            if proc.poll() is None:
                with contextlib.suppress(ProcessLookupError):os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()


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
        body = json.dumps(value).encode(); self.send_response(status); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.send_header('Cache-Control', 'no-store'); self.send_header('X-Bento-Service-Revision', SERVICE_REVISION); self.end_headers(); self.wfile.write(body)
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
        if self.path not in ('/resolve', '/stats') or not self.authorized():
            return self.reply(401, {'error': 'Unauthorized'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 4096:
                raise Failure('error.api.link.invalid')
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict):
                raise Failure('error.api.link.invalid')
            if self.path == '/stats' and set(value) != {'url'}:
                raise Failure('error.api.link.invalid')
            self.reply(200, statistics(value) if self.path == '/stats' else extract(value))
        except Failure as error:
            self.reply(422, {'code': error.code})
        except Exception as error:
            self.reply(502, {'code': 'error.api.metadata.handler.' + type(error).__name__ if self.path == '/stats' else 'error.api.fetch.fail'})
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
    if sys.argv[1:] == ['--stats-child']:
        try:
            value = json.load(sys.stdin)
            COOKIE_JAR = value.get('cookieJar', '')
            result = extract_statistics(value['url'], value['directory'])
        except Failure as error:
            result = {'error': error.code}
        except Exception as error:
            result = {'error': 'error.api.metadata.child.' + type(error).__name__}
        print(json.dumps(result), flush=True)
        raise SystemExit(0)
    if not AUTH:raise SystemExit('Missing service authentication')
    server = ThreadingHTTPServer(('0.0.0.0', 8080), Handler);server.daemon_threads = True;server.serve_forever()
