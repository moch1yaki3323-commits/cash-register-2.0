import importlib.util
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sms_server', Path(__file__).with_name('server.py'))
sms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sms)

class BackendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        sms.DB_PATH = str(Path(self.tmp.name)/'requests.sqlite3')
        sms.init_db()
        self.token = 'unit-test-only-no-provider-secret-'*2
        self.env = patch.dict(os.environ, {'SMS_APP_TOKEN': self.token, 'SMS_ALLOWED_ORIGIN': 'https://pos.example.test'})
        self.env.start()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), sms.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.env.stop()
        self.tmp.cleanup()

    def request(self, req_id='request-1', token=None, origin='https://pos.example.test', message='001 ready'):
        req = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}/api/sms', data=json.dumps({'requestId': req_id, 'phone': '+886912345678', 'message': message}).encode(), headers={'Authorization': 'Bearer '+(self.token if token is None else token), 'Origin': origin, 'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_auth_origin_and_idempotency(self):
        with patch.object(sms, 'send_twilio', return_value='SM-test-only') as provider:
            self.assertEqual(self.request(token='invalid')[0], 401)
            self.assertEqual(self.request(origin='https://untrusted.example')[0], 403)
            self.assertEqual(self.request(), (200, {'status': 'accepted', 'messageId': 'SM-test-only'}))
            self.assertEqual(self.request()[0], 200)
            self.assertEqual(provider.call_count, 1)
            self.assertEqual(self.request(message='different')[0], 409)

    def test_uncertain_result_never_retries_automatically(self):
        with patch.object(sms, 'send_twilio', side_effect=TimeoutError) as provider:
            self.assertEqual(self.request()[0], 502)
            self.assertEqual(self.request()[0], 409)
            self.assertEqual(provider.call_count, 1)

if __name__ == '__main__':
    unittest.main()
