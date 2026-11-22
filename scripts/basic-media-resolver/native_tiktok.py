"""Download one public TikTok through yt-dlp's own complete request session."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit

from service import Failure, MAX_BYTES, Quiet, choose, media_url, public_info, source

TRACE = {}


def request_url(value):
    """Validate requests before dispatch and the final response URL before reading media."""
    p = urlsplit(value)
    if p.scheme != 'https' or p.username or p.password or p.port not in (None, 443):
        raise Failure('error.api.link.invalid')
    if p.hostname in ('www.tiktok.com', 'm.tiktok.com', 'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'):
        return value
    return media_url('tiktok', value)


def download(url, folder, mode, quality):
    import yt_dlp
    platform, expected, canonical = source(url)
    if platform != 'tiktok':raise Failure('error.api.link.invalid')
    os.umask(0o077)
    deadline = time.monotonic() + 25 * 60
    completed = False
    def select(ctx):
        TRACE['stage'] = 'selection'
        TRACE['formats'] = [{k: f.get(k) for k in ('vcodec','acodec','width','height','protocol')} | {'host': urlsplit(f.get('url', '')).hostname} for f in ctx.get('formats', [])[:10]]
        formats = choose('tiktok', {'formats': ctx.get('formats', [])}, mode, quality)
        # Native clip audio must stay attached to the video, not the backing-song entry.
        if len(formats) != 1:raise Failure('error.api.content.unavailable')
        yield formats[0]
    def public_filter(info, *, incomplete=False):
        TRACE['stage'] = 'public_metadata'
        if not incomplete:public_info('tiktok', expected, info)
        return None
    def progress(value):
        nonlocal completed
        if value.get('downloaded_bytes', 0) > MAX_BYTES:raise Failure('error.api.content.too_large')
        if time.monotonic() > deadline:raise Failure('error.api.fetch.fail')
        if value.get('status') == 'finished':completed = True
    options = {
        'format': select, 'outtmpl': str(Path(folder) / 'native.%(ext)s'),
        'quiet': True, 'no_warnings': True, 'logger': Quiet(),
        'noplaylist': True, 'cachedir': False, 'continuedl': False,
        'retries': 1, 'extractor_retries': 1, 'fragment_retries': 0,
        'socket_timeout': 12, 'max_filesize': MAX_BYTES, 'buffersize': 65536,
        'noresizebuffer': True, 'skip_unavailable_fragments': False,
        'match_filter': public_filter, 'progress_hooks': [progress],
        'compat_opts': {'no-certifi'}, 'fixup': 'never',
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        original = ydl.urlopen
        def guarded(req):
            request_url(req if isinstance(req, str) else req.url)
            response = original(req)
            try:request_url(response.url)
            except Exception:
                response.close()
                raise
            return response
        ydl.urlopen = guarded
        # Extraction, headers, anonymous cookies and the file download share this instance.
        TRACE['stage'] = 'extract'
        info = ydl.extract_info(canonical, download=True)
    TRACE['stage'] = 'completed_file'
    if not info or not completed:raise Failure('error.api.content.unavailable')
    files = [p for p in Path(folder).iterdir() if p.name.startswith('native.') and p.suffix in ('.mp4', '.webm', '.mov')]
    if len(files) != 1 or not 0 < files[0].stat().st_size <= MAX_BYTES:raise Failure('error.api.content.too_large')
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-show_entries', 'format=duration', '-of', 'json', str(files[0])], capture_output=True, text=True, timeout=10)
    if probe.returncode:raise Failure('error.api.fetch.fail')
    data = json.loads(probe.stdout)
    if not any(s.get('codec_type') == 'video' for s in data.get('streams', [])) or float(data.get('format', {}).get('duration', 0)) <= 0:raise Failure('error.api.fetch.fail')
    audio = next((s.get('codec_name', '') for s in data.get('streams', []) if s.get('codec_type') == 'audio'), '')
    return {'filename': files[0].name, 'bytes': files[0].stat().st_size, 'acodec': audio}


def main():
    try:
        if len(sys.argv) != 5 or sys.argv[3] not in ('video', 'audio'):raise Failure('error.api.link.invalid')
        result = download(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
    except Exception as error:
        message = str(error).lower()
        result = {'error': error.code if isinstance(error, Failure) else 'error.api.tiktok.blocked' if '403' in message or 'ip address is blocked' in message else 'error.api.fetch.fail', 'diagnostic': TRACE}
    print(json.dumps(result), flush=True)

if __name__ == '__main__':main()
