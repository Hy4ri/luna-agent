"""Offline tests of the actual native transport, HTTP gate, and stdio bridge."""
import copy
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

import directsdk
from admission import Admission, restore_queried_turn, pin_message_breakpoint

HERE = Path(__file__).resolve().parent
USAGE = {"input_tokens": 11, "output_tokens": 7,
         "cache_read_input_tokens": 13, "cache_creation_input_tokens": 17}


class Peer(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append(body)
        message = {"id": "msg-fixture", "type": "message", "role": "assistant", "model": "test",
                   "content": [], "usage": USAGE, "stop_reason": None}
        events = [
            {"type": "message_start", "message": message},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "actual upstream"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": USAGE},
            {"type": "message_stop"},
        ]
        data = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class NativeTransportTests(unittest.TestCase):
    def test_history_preserves_signed_turn_and_actual_host_result(self):
        message = {"role": "assistant", "content": "calling", "tool_calls": [
            {"id": "call-1", "type": "function", "function": {"name": "lookup", "arguments": '{"key":"actual"}'}}]}
        native = {"id": "msg-native", "role": "assistant", "usage": USAGE, "content": [
            {"type": "thinking", "thinking": "reason", "signature": "opaque-signed-reasoning"},
            {"type": "text", "text": "calling"},
            {"type": "tool_use", "id": "call-1", "name": "mcp__hermes__lookup", "input": {"key": "actual"}},
        ]}
        carrier = {"type": directsdk.CARRIER, "version": 1, "projection": directsdk.projection(message), "messages": [native]}
        message['reasoning_details'] = [carrier]
        image = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AA=="}}
        history = [{"role": "system", "content": "policy"}, {"role": "user", "content": "first"}, message,
                   {"role": "tool", "tool_call_id": "call-1", "content": [{"type": "text", "text": "real-host-value"}, image], "is_error": True}]
        original = copy.deepcopy(history)
        system, frames = directsdk.prepare_history(history, {"lookup": "lookup"})
        self.assertEqual(system, 'policy')
        self.assertEqual(history, original)
        self.assertEqual(frames[1]['message']['content'], native['content'])
        self.assertNotIn('usage', frames[1]['message'])
        self.assertEqual(frames[-1]['message']['content'], [{"type": "tool_result", "tool_use_id": "call-1",
                         "content": [{"type": "text", "text": "real-host-value"}, image], "is_error": True}])
        first_id = directsdk.conversation_session_id(system, frames)
        _, later = directsdk.prepare_history(history + [{"role": "assistant", "content": "done"}, {"role": "user", "content": "next"}])
        self.assertEqual(first_id, directsdk.conversation_session_id(system, later))
        history[2]['content'] = 'host-edited'
        _, changed = directsdk.prepare_history(history, {"lookup": "lookup"})
        self.assertEqual(changed[1]['message']['content'][0], {"type": "text", "text": "host-edited"})
        self.assertNotIn('opaque-signed-reasoning', json.dumps(changed))

    def test_restore_tool_result_and_pin_recurring_cache_prefix(self):
        host = [{"type": "tool_result", "tool_use_id": "call-1", "content": "actual host", "is_error": False}]
        sent = copy.deepcopy(host)
        sent[0]['content'] += '\n<system-reminder>native account notice</system-reminder>'
        sent.append({"type": "text", "text": "native per-request context", "cache_control": {"type": "ephemeral"}})
        payload = {"messages": [{"role": "assistant", "content": [{"type": "tool_use", "id": "call-1", "name": "lookup", "input": {}}]},
                                {"role": "user", "content": sent}]}
        # The restoration path accepts only unmarked trailing plain text.
        sent[-1].pop('cache_control')
        restored = json.loads(restore_queried_turn(json.dumps(payload).encode(), host))
        self.assertEqual(restored['messages'][-1]['content'], host)
        payload['messages'][-1]['content'][-1]['cache_control'] = {"type": "ephemeral"}
        pinned = json.loads(pin_message_breakpoint(json.dumps(payload).encode(), host))
        self.assertNotIn('cache_control', pinned['messages'][-1]['content'][-1])
        self.assertIn('cache_control', pinned['messages'][0]['content'][-1])

    def relay(self, queried=None):
        peer = ThreadingHTTPServer(('127.0.0.1', 0), Peer)
        peer.requests = []
        thread = threading.Thread(target=peer.serve_forever, daemon=True)
        thread.start()
        gate = Admission(f'http://127.0.0.1:{peer.server_port}', 3, queried=queried)
        def cleanup():
            gate.close()
            peer.shutdown()
            thread.join()
            peer.server_close()
        self.addCleanup(cleanup)
        return gate, peer

    def post(self, gate, body):
        connection = http.client.HTTPConnection('127.0.0.1', gate.server.server_port, timeout=4)
        try:
            connection.request('POST', gate.prefix + '/v1/messages', json.dumps(body), {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_admission_forwards_only_one_request_and_captures_real_usage(self):
        gate, peer = self.relay()
        body = {"model": "test", "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}
        self.assertEqual(self.post(gate, body)[0], 200)
        self.assertTrue(gate.capture.complete)
        self.assertEqual(gate.capture.message['content'], [{"type": "text", "text": "actual upstream"}])
        self.assertEqual(gate.capture.message['usage'], USAGE)
        self.assertEqual(self.post(gate, body)[0], 400)
        self.assertEqual(len(peer.requests), 1)
        self.assertEqual(gate.denied, 1)

    def test_mismatched_tool_result_is_not_forwarded(self):
        host = [{"type": "tool_result", "tool_use_id": "call-1", "content": "actual-host-result", "is_error": False}]
        gate, peer = self.relay(host)
        body = {"model": "test", "messages": [{"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "call-1", "content": "synthetic permission denial", "is_error": True}]}]}
        status, _ = self.post(gate, body)
        self.assertGreaterEqual(status, 400)
        self.assertEqual(peer.requests, [], 'native may not replace authoritative host tool results')

    def bridge(self, command, messages, extra_env=None, timeout=5):
        env = {'PATH': os.defpath, 'HOME': str(Path(command).parent), 'PYTHONIOENCODING': 'utf-8'}
        env.update(extra_env or {})
        return subprocess.run([sys.executable, '-B', '-u', str(HERE / 'bridge.py')], env=env,
                              input=json.dumps({'command': str(command), 'request': {'model': 'test', 'messages': messages}}),
                              text=True, capture_output=True, timeout=timeout)

    def fake_cli(self, root, hang=False):
        path = root / 'fake-claude'
        path.write_text(f'#!{sys.executable}\n' + '''import json, os, subprocess, sys, time
for line in sys.stdin:
    frame=json.loads(line)
    with open(os.environ['RECEIPT'], 'a') as out: out.write(json.dumps(frame)+'\\n')
    if frame.get('shouldQuery') is False:
        print(json.dumps({'type':'result','num_turns':0,'is_error':False}),flush=True)
''' + ('''with open(os.environ['RECEIPT'], 'a') as out: out.write(str(os.getpid())+'\\n')
time.sleep(60)
''' if hang else '''message={'id':'msg-fixture','role':'assistant','content':[{'type':'text','text':'Hello λ'}], 'stop_reason':'end_turn','usage':{'input_tokens':11,'output_tokens':7}}
print(json.dumps({'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'Hello λ'}}}),flush=True)
print(json.dumps({'type':'assistant','message':message}),flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'message_stop'}}),flush=True)
print(json.dumps({'type':'result','subtype':'success','is_error':False,'usage':message['usage']}),flush=True)
'''), encoding='utf-8')
        path.chmod(0o700)
        return path

    def test_bridge_serializes_real_response_and_replays_history_without_querying_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = root / 'frames'
            command = self.fake_cli(root)
            messages = [{"role": "user", "content": "old"}, {"role": "assistant", "content": "old answer"}, {"role": "user", "content": "latest"}]
            process = self.bridge(command, messages, {'RECEIPT': str(receipt)})
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            events = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertEqual([e['type'] for e in events], ['delta', 'response'])
            self.assertEqual(events[-1]['response']['choices'][0]['message']['content'], 'Hello λ')
            frames = [json.loads(line) for line in receipt.read_text().splitlines()]
            self.assertEqual([f['type'] for f in frames], ['user', 'assistant', 'user'])
            self.assertIs(frames[0]['shouldQuery'], False)
            self.assertNotIn('shouldQuery', frames[-1])
            self.assertEqual(frames[-1]['message']['content'], [{'type': 'text', 'text': 'latest'}])

    def test_missing_cli_and_conflicting_auth_fail_before_cli_spawn(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = self.fake_cli(root)
            receipt = root / 'frames'
            messages = [{"role": "user", "content": "hi"}]
            missing = self.bridge(root / 'missing', messages)
            self.assertEqual(missing.returncode, 1)
            self.assertEqual(json.loads(missing.stdout)['statusCode'], 503)
            for conflict in ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_VERTEX']:
                failed = self.bridge(command, messages, {'RECEIPT': str(receipt), conflict: 'fixture-conflict'})
                self.assertEqual(failed.returncode, 1, conflict)
                self.assertIn('conflicting', json.loads(failed.stdout)['message'])
                self.assertFalse(receipt.exists())

    def test_truncated_tool_use_finishes_as_length_not_actionable_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = root / 'truncated-native'
            message = {'id': 'msg-truncated', 'role': 'assistant', 'content': [
                {'type': 'tool_use', 'id': 'call-cut', 'name': 'mcp__hermes__lookup', 'input': {}}
            ], 'stop_reason': 'max_tokens', 'usage': USAGE}
            for stop in ['max_tokens', 'model_context_window_exceeded']:
                with self.subTest(stop_reason=stop):
                    message['stop_reason'] = stop
                    events = [
                        {'type': 'assistant', 'message': message},
                        {'type': 'stream_event', 'event': {'type': 'message_stop'}},
                        {'type': 'result', 'subtype': 'error_max_turns', 'is_error': True, 'usage': USAGE},
                    ]
                    command.write_text(f'#!{sys.executable}\nimport sys\nfor line in sys.stdin: pass\n' +
                                       '\n'.join(f'print({json.dumps(json.dumps(event))}, flush=True)' for event in events) + '\nsys.exit(1)\n')
                    command.chmod(0o700)
                    result = self.bridge(command, [{'role': 'user', 'content': 'Call lookup'}])
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    response = [json.loads(line) for line in result.stdout.splitlines()][-1]['response']
                    self.assertEqual(response['choices'][0]['finish_reason'], 'length',
                                     'a complete first tool call does not make a truncated batch safe')

    def test_real_typescript_provider_bridge_and_signed_tool_result_roundtrip(self):
        # No transport mocks: pi -> provider -> Python bridge -> synthetic CLI.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = root / 'roundtrip-native'
            receipt = root / 'frames'
            command.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
frames=[]
for line in sys.stdin:
    frame=json.loads(line); frames.append(frame)
    with open(os.environ['RECEIPT'], 'a') as out: out.write(json.dumps(frame)+'\\n')
    if frame.get('shouldQuery') is False:
        print(json.dumps({'type':'result','num_turns':0,'is_error':False}),flush=True)
latest=frames[-1]['message']['content']
if latest[0]['type']=='tool_result':
    assert latest==[{'type':'tool_result','tool_use_id':'call-actual','is_error':True,'content':[
        {'type':'text','text':'actual host failure'},
        {'type':'image','source':{'type':'base64','media_type':'image/png','data':'AA=='}}
    ]}], latest
    assert frames[0]['shouldQuery'] is False
    assert frames[1]['message']['content'][0]=={'type':'thinking','thinking':'native thought','signature':'opaque-signature'}
    blocks=[{'type':'text','text':'actual host failure'}]; stop='end_turn'; subtype='success'; code=0
else:
    assert latest==[{'type':'text','text':'Look up the value.'}], latest
    blocks=[{'type':'thinking','thinking':'native thought','signature':'opaque-signature'},
            {'type':'tool_use','id':'call-actual','name':'mcp__hermes__lookup','input':{}}]
    stop='tool_use'; subtype='error_max_turns'; code=1
usage={'input_tokens':11,'output_tokens':7,'cache_read_input_tokens':13,'cache_creation_input_tokens':17}
message={'id':'msg-roundtrip','role':'assistant','content':blocks,'stop_reason':stop,'usage':usage}
print(json.dumps({'type':'assistant','message':message}),flush=True)
print(json.dumps({'type':'stream_event','event':{'type':'message_stop'}}),flush=True)
print(json.dumps({'type':'result','subtype':subtype,'is_error':code==1,'usage':usage}),flush=True)
sys.exit(code)
''', encoding='utf-8')
            command.chmod(0o700)
            provider_url = (HERE.parent / 'claude-cli.ts').as_uri()
            script = '''import assert from 'node:assert/strict';
import {createModels} from '@earendil-works/pi-ai';
import {claudeCliProvider} from PROVIDER_URL;
const models=createModels(); models.setProvider(claudeCliProvider());
const model=models.getModels('claude-cli')[0];
const context={systemPrompt:'Use actual host results.',tools:[{name:'lookup',description:'Read a value',parameters:{type:'object',properties:{}}}],messages:[{role:'user',content:'Look up the value.',timestamp:1}]};
const first=await models.streamSimple(model,context).result();
assert.equal(first.stopReason,'toolUse',first.errorMessage);
const call=first.content.find(b=>b.type==='toolCall');
assert.equal(call.name,'lookup'); assert.deepEqual(call.arguments,{});
assert.ok(first.content.some(b=>b.type==='text'&&b.textSignature.includes('opaque-signature')));
context.messages.push(first,{role:'toolResult',toolCallId:call.id,toolName:call.name,isError:true,content:[{type:'text',text:'actual host failure'},{type:'image',mimeType:'image/png',data:'AA=='}],timestamp:2});
const second=await models.streamSimple(model,context).result();
assert.equal(second.stopReason,'stop',second.errorMessage);
assert.equal(second.content.find(b=>b.type==='text').text,'actual host failure');
assert.equal(second.usage.totalTokens,48);
console.log('PROVIDER_BRIDGE_ROUNDTRIP_OK');
'''.replace('PROVIDER_URL', json.dumps(provider_url))
            env = {'PATH': os.environ['PATH'], 'HOME': directory, 'CLAUDE_CONFIG_DIR': directory,
                   'LUNA_CLAUDE_EXECUTABLE': str(command), 'LUNA_CLAUDE_PYTHON': sys.executable,
                   'RECEIPT': str(receipt)}
            process = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', script],
                                     env=env, cwd=HERE.parents[1], text=True, capture_output=True, timeout=15)
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            self.assertIn('PROVIDER_BRIDGE_ROUNDTRIP_OK', process.stdout)
            frames = [json.loads(line) for line in receipt.read_text().splitlines()]
            self.assertEqual([frame['type'] for frame in frames], ['user', 'user', 'assistant', 'user'])

    def test_bridge_signal_cancels_owned_native_process(self):
        if os.name == 'nt':
            self.skipTest('POSIX signal qualification')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = root / 'frames'
            command = self.fake_cli(root, hang=True)
            env = {'PATH': os.defpath, 'HOME': directory, 'RECEIPT': str(receipt)}
            process = subprocess.Popen([sys.executable, '-B', '-u', str(HERE / 'bridge.py')], env=env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(lambda: process.poll() is None and process.kill())
            process.stdin.write(json.dumps({'command': str(command), 'request': {'model': 'test', 'messages': [{"role": "user", "content": "hi"}]}}))
            process.stdin.close()
            deadline = time.monotonic() + 3
            pid = None
            while time.monotonic() < deadline:
                if receipt.exists() and receipt.read_text().splitlines()[-1].isdigit():
                    pid = int(receipt.read_text().splitlines()[-1]); break
                time.sleep(.02)
            self.assertIsNotNone(pid, 'fake native child did not start')
            process.terminate()
            process.wait(timeout=3)
            self.assertNotEqual(process.returncode, 0)
            process.stdout.close(); process.stderr.close()
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)


if __name__ == '__main__':
    unittest.main()
