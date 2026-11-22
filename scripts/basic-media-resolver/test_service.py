import importlib.util
import unittest
import sys
import io
import time
import types
from unittest.mock import patch, MagicMock
from pathlib import Path

spec = importlib.util.spec_from_file_location('basic_media_service', Path(__file__).with_name('service.py'))
service = importlib.util.module_from_spec(spec);spec.loader.exec_module(service)

class PublicMediaPolicy(unittest.TestCase):
    def test_only_supported_source_hosts_and_ids(self):
        self.assertEqual(service.source('https://youtu.be/jNQXAC9IVRw')[2], 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
        for url in ['http://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com.evil/watch?v=jNQXAC9IVRw', 'https://user@youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com/playlist?list=private', 'https://127.0.0.1/a', 'https://www.tiktok.com/@a/video/not-id']:
            with self.subTest(url=url), self.assertRaises(service.Failure):service.source(url)
    def test_cdn_allowlist_and_redirect_boundaries(self):
        service.media_url('youtube','https://rr1.googlevideo.com/videoplayback?id=public')
        service.media_url('tiktok','https://v16-webapp-prime.tiktok.com/video/public')
        for platform,url in [('youtube','https://googlevideo.com.evil/videoplayback'),('youtube','https://rr1.googlevideo.com/redirect'),('youtube','https://rr1.googlevideo.com:444/videoplayback'),('tiktok','https://www.tiktok.com/login'),('tiktok','https://127.0.0.1/a')]:
            with self.subTest(url=url),self.assertRaises(service.Failure):service.media_url(platform,url)
    def test_public_only_cookie_results(self):
        base={'id':'jNQXAC9IVRw','extractor_key':'Youtube','availability':'public','duration':19}
        service.public_info('youtube','jNQXAC9IVRw',base)
        for key,value in [('availability','private'),('availability','unlisted'),('availability','needs_auth'),('availability',None),('is_private',True),('is_unlisted',True),('age_limit',18),('is_live',True),('duration',86401),('id','another-id')]:
            with self.subTest(key=key,value=value),self.assertRaises(service.Failure):service.public_info('youtube','jNQXAC9IVRw',{**base,key:value})
    def test_tiktok_does_not_need_account_metadata(self):
        service.public_info('tiktok','7039716639834656002',{'id':'7039716639834656002','extractor_key':'TikTok','duration':11})
    def test_compatible_video_and_clip_audio_selection(self):
        video={'url':'https://rr1.googlevideo.com/videoplayback?id=v','width':1280,'height':720,'vcodec':'avc1.64001f','acodec':'none','protocol':'https'}
        audio={'url':'https://rr1.googlevideo.com/videoplayback?id=a','vcodec':'none','acodec':'mp4a.40.2','abr':128,'protocol':'https'}
        hevc={**video,'url':'https://rr1.googlevideo.com/videoplayback?id=hevc','vcodec':'hvc1','height':1080}
        info={'formats':[hevc,video,audio]}
        self.assertEqual(service.choose('youtube',info,'video','720'),[video,audio])
        self.assertEqual(service.choose('youtube',info,'audio','720'),[audio])
        with self.assertRaises(service.Failure):service.choose('youtube',{'formats':[hevc,audio]},'video','max')
    def test_tiktok_audio_uses_the_clip_not_the_backing_song(self):
        clip={'url':'https://v16-webapp-prime.tiktok.com/video/public','vcodec':'h264','acodec':'aac','width':576,'height':1024}
        song={'url':'https://v77.tiktokcdn.com/music/public','vcodec':'none','acodec':'mp4a','abr':320}
        self.assertEqual(service.choose('tiktok',{'formats':[clip,song]},'audio','720'),[clip])
    def test_browser_cdn_transport_rejects_redirects_before_contacting_an_unsafe_host(self):
        response = types.SimpleNamespace(status_code=302, headers={'location':'https://127.0.0.1/private'}, close=MagicMock())
        session = MagicMock()
        session.__enter__.return_value = session
        session.get.return_value = response
        module = types.SimpleNamespace(requests=types.SimpleNamespace(Session=MagicMock(return_value=session)))
        with patch.dict(sys.modules, {'curl_cffi':module}):
            with self.assertRaises(service.Failure):service.download_media('tiktok', {'url':'https://v16-webapp-prime.tiktok.com/video/public','headers':{}}, io.BytesIO(), service.MAX_BYTES, time.monotonic() + 10)
        session.get.assert_called_once()
        self.assertFalse(session.get.call_args.kwargs['allow_redirects'])
        response.close.assert_called_once()
    def test_browser_cdn_transport_streams_verified_hosts_without_buffering(self):
        response = types.SimpleNamespace(status_code=200, headers={}, iter_content=lambda **_:iter([b'first',b'second']), close=MagicMock())
        session = MagicMock()
        session.__enter__.return_value = session
        def get(*args, **kwargs):
            for chunk in (b'first', b'second'):self.assertEqual(kwargs['content_callback'](chunk), len(chunk))
            return response
        session.get.side_effect = get
        module = types.SimpleNamespace(requests=types.SimpleNamespace(Session=MagicMock(return_value=session)))
        out = io.BytesIO()
        with patch.dict(sys.modules, {'curl_cffi':module}):
            self.assertEqual(service.download_media('tiktok', {'url':'https://v16-webapp-prime.tiktok.com/video/public','headers':{}}, out, service.MAX_BYTES, time.monotonic() + 10), 11)
        self.assertEqual(out.getvalue(), b'firstsecond')
        self.assertNotIn('stream', session.get.call_args.kwargs)
        response.close.assert_called_once()
    def test_disk_callback_aborts_before_writing_beyond_the_remaining_byte_budget(self):
        session = MagicMock()
        session.__enter__.return_value = session
        def get(*args, **kwargs):
            self.assertEqual(kwargs['content_callback'](b'12345'), 0)
            raise RuntimeError('simulated curl write abort')
        session.get.side_effect = get
        module = types.SimpleNamespace(requests=types.SimpleNamespace(Session=MagicMock(return_value=session)))
        out = io.BytesIO()
        with patch.dict(sys.modules, {'curl_cffi':module}), self.assertRaises(service.Failure) as error:
            service.download_media('tiktok', {'url':'https://v16-webapp-prime.tiktok.com/video/public','headers':{}}, out, 4, time.monotonic() + 10)
        self.assertEqual(error.exception.code, 'error.api.content.too_large')
        self.assertEqual(out.getvalue(), b'')
    def test_large_or_unsafe_formats_never_reach_ffmpeg(self):
        bad={'url':'https://127.0.0.1/private','vcodec':'h264','acodec':'aac','width':720,'height':1280}
        with self.assertRaises(service.Failure):service.choose('tiktok',{'formats':[bad]},'video','720')
        large={**bad,'url':'https://v16-webapp-prime.tiktok.com/video/public','filesize':service.MAX_BYTES+1}
        with self.assertRaises(service.Failure):service.choose('tiktok',{'formats':[large]},'video','720')

if __name__=='__main__':unittest.main()
