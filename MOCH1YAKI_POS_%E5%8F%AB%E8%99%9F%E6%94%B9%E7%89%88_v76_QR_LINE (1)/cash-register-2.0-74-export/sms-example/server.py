"""Optional Twilio adapter. Run behind HTTPS; provider credentials never reach HTML.
Requires Python 3.12+, no pip packages. See README.md before use.
"""
import base64
import hashlib
import hmac
import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()
DB_PATH = os.environ.get('SMS_DB_PATH', 'sms-requests.sqlite3')

def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.execute('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, digest TEXT, state TEXT, sid TEXT, created REAL)')

def send_twilio(phone, message):
    sid, token, sender = (os.environ.get(k, '') for k in ('SMS_TWILIO_ACCOUNT_SID', 'SMS_TWILIO_AUTH_TOKEN', 'SMS_TWILIO_FROM'))
    if not all((sid, token, sender)):
        raise RuntimeError('provider_not_configured')
    if not sid.startswith('AC') or not sid.isalnum():
        raise RuntimeError('provider_not_configured')
    req = urllib.request.Request(
        f'https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json',
        data=urllib.parse.urlencode({'To': phone, 'From': sender, 'Body': message}).encode(),
        headers={'Authorization': 'Basic '+base64.b64encode(f'{sid}:{token}'.encode()).decode(), 'Content-Type': 'application/x-www-form-urlencoded'},
        method='POST')
    with urllib.request.urlopen(req, timeout=15) as response:
        result = json.load(response)
    if not result.get('sid') or result.get('status') in ('failed', 'undelivered'):
        raise RuntimeError('provider_rejected')
    return str(result['sid'])

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not log phone numbers, authorization headers, or message bodies.

    def headers_common(self):
        origin = os.environ.get('SMS_ALLOWED_ORIGIN', '')
        if self.headers.get('Origin') == origin:
            self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.send_header('Cache-Control', 'no-store')

    def reply(self, status, payload):
        self.send_response(status)
        self.headers_common()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def do_OPTIONS(self):
        if self.headers.get('Origin') != os.environ.get('SMS_ALLOWED_ORIGIN'):
            return self.reply(403, {'error': 'origin_not_allowed'})
        self.send_response(204)
        self.headers_common()
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_POST(self):
        if self.path != '/api/sms':
            return self.reply(404, {'error': 'not_found'})
        token = os.environ.get('SMS_APP_TOKEN', '')
        if len(token) < 32:
            return self.reply(503, {'error': 'backend_not_configured'})
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer '+token):
            return self.reply(401, {'error': 'unauthorized'})
        origin = os.environ.get('SMS_ALLOWED_ORIGIN', '')
        if not origin or self.headers.get('Origin') != origin:
            return self.reply(403, {'error': 'origin_not_allowed'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 16000:
                return self.reply(413, {'error': 'invalid_payload_size'})
            payload = json.loads(self.rfile.read(length))
            request_id, phone, text = (str(payload.get(k, '')).strip() for k in ('requestId', 'phone', 'message'))
            import re
            if not re.fullmatch(r'[A-Za-z0-9-]{1,100}', request_id) or not re.fullmatch(r'\+[1-9]\d{7,14}', phone) or not 1 <= len(text) <= 1500:
                return self.reply(400, {'error': 'invalid_payload'})
        except (ValueError, TypeError):
            return self.reply(400, {'error': 'invalid_json'})
        digest = hashlib.sha256((phone+'\0'+text).encode()).hexdigest()
        with LOCK, sqlite3.connect(DB_PATH) as db:
            old = db.execute('SELECT digest,state,sid FROM requests WHERE id=?', (request_id,)).fetchone()
            if old:
                if old[0] != digest:
                    return self.reply(409, {'error': 'request_id_conflict'})
                if old[1] == 'accepted':
                    return self.reply(200, {'status': 'accepted', 'messageId': old[2]})
                return self.reply(409, {'error': 'previous_send_unconfirmed_check_provider'})
            count = db.execute('SELECT count(*) FROM requests WHERE created>?', (time.time()-60,)).fetchone()[0]
            if count >= 10:
                return self.reply(429, {'error': 'rate_limited'})
            # Commit before network I/O: an uncertain outcome must never trigger an automatic duplicate send.
            db.execute('INSERT INTO requests VALUES(?,?,?,?,?)', (request_id, digest, 'pending', '', time.time()))
            db.commit()
            try:
                sid = send_twilio(phone, text)
            except (RuntimeError, urllib.error.URLError, ValueError, TimeoutError):
                db.execute('UPDATE requests SET state=? WHERE id=?', ('unconfirmed', request_id))
                db.commit()
                return self.reply(502, {'error': 'send_unconfirmed_check_provider'})
            db.execute('UPDATE requests SET state=?,sid=? WHERE id=?', ('accepted', sid, request_id))
            db.commit()
        return self.reply(200, {'status': 'accepted', 'messageId': sid})

if __name__ == '__main__':
    init_db()
    ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('SMS_PORT', '8787'))), Handler).serve_forever()
