import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
import types

sys.path.insert(0, str(Path(__file__).parent))
import service
import native_tiktok

class NativeTikTokPolicy(unittest.TestCase):
    def test_dimensionless_h264_download_is_usable_when_no_sized_variant_exists(self):
        clip={'protocol':'https','url':'https://v16-webapp-prime.tiktok.com/video/public','vcodec':'h264','acodec':'aac'}
        self.assertEqual(service.choose('tiktok',{'formats':[clip]},'video','720'),[clip])
    def test_muxed_clip_wins_over_larger_silent_video_and_backing_song(self):
        base={'protocol':'https','url':'https://v16-webapp-prime.tiktok.com/video/public'}
        formats=[{**base,'format_id':'silent','vcodec':'h264','acodec':'none','width':720,'height':1280},{**base,'format_id':'song','vcodec':'none','acodec':'mp3'},{**base,'format_id':'clip','vcodec':'h264','acodec':'aac','width':576,'height':1024}]
        selected=service.choose('tiktok',{'formats':formats},'video','720')
        self.assertEqual([f['format_id'] for f in selected], ['clip'])
        for mode in ['video','audio']:
            with self.assertRaises(service.Failure):service.choose('tiktok',{'formats':formats[:2]},mode,'720')
    def test_full_tiktok_url_queues_one_native_session_without_detached_extraction(self):
        with patch.dict(sys.modules, {'yt_dlp':types.SimpleNamespace()}), patch.dict(service.JOBS, {}, clear=True):
            result=service.extract({'url':'https://www.tiktok.com/@a/video/7039716639834656002','videoQuality':'720'})
            job=service.JOBS[result['id']]
            self.assertEqual(job['inputs'], [])
            self.assertEqual(job['native_source'], 'https://www.tiktok.com/@a/video/7039716639834656002')
            self.assertEqual(result['filename'], 'tiktok-7039716639834656002.mp4')
    def test_only_first_party_requests_are_allowed(self):
        for value in ['https://www.tiktok.com/@a/video/7039716639834656002','https://v16-webapp-prime.tiktok.com/video/public']:
            self.assertEqual(native_tiktok.request_url(value), value)
        for value in ['http://www.tiktok.com/', 'https://127.0.0.1/', 'https://www.tiktok.com.evil/', 'https://user@www.tiktok.com/', 'https://www.tiktok.com:444/', 'https://www.youtube.com/']:
            with self.assertRaises(service.Failure):native_tiktok.request_url(value)
    def test_native_child_never_receives_google_or_bridge_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'native.mp4').write_bytes(b'verified-by-native-process')
            completed=types.SimpleNamespace(returncode=0, stdout=json.dumps({'filename':'native.mp4','acodec':'aac'}))
            with patch.dict(os.environ, {'YOUTUBE_COOKIE_JAR':'secret-cookie','INTERNAL_TOKEN':'private-bridge'}), patch.object(service.subprocess, 'run', return_value=completed) as run:
                result=service.native_tiktok_input({'native_source':'https://www.tiktok.com/@a/video/7039716639834656002','mode':'video','quality':'720'}, folder)
            self.assertEqual(result, (str(Path(folder, 'native.mp4')), 'aac'))
            self.assertIsInstance(run.call_args.args[0], list)
            self.assertNotIn('YOUTUBE_COOKIE_JAR', run.call_args.kwargs['env'])
            self.assertNotIn('INTERNAL_TOKEN', run.call_args.kwargs['env'])
            self.assertNotIn('shell', run.call_args.kwargs)
    def test_native_result_cannot_escape_its_private_directory(self):
        result=types.SimpleNamespace(returncode=0, stdout=json.dumps({'filename':'../../secret','acodec':'aac'}))
        with tempfile.TemporaryDirectory() as folder, patch.object(service.subprocess, 'run', return_value=result):
            with self.assertRaises(service.Failure):service.native_tiktok_input({'native_source':'https://www.tiktok.com/@a/video/7039716639834656002','mode':'video','quality':'720'}, folder)

if __name__=='__main__':unittest.main()
