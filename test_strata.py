import json
import unittest
from unittest.mock import patch

import pulse_agent


class Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self):
        return json.dumps(self.payload).encode()


class StrataTests(unittest.TestCase):
    def test_matches_server_parent_only(self):
        self.assertTrue(pulse_agent._is_strata_argv([
            "/python", "/opt/strata/serve/server.py", "--engine", "strata",
            "--config", "/tmp/profile.json",
        ]))
        self.assertFalse(pulse_agent._is_strata_argv([
            "/opt/engine/strata", "--serve", "--pack", "/models/pack",
        ]))
        self.assertFalse(pulse_agent._is_strata_argv([
            "/python", "/opt/strata/serve/server.py", "--engine", "other",
        ]))

    def test_telemetry_is_compact_and_never_returns_key(self):
        payload = {
            "engine": {"model": "qwen", "max_context": 210944,
                       "expert_cache_mib": 14457},
            "live": {"state": "generating", "tok_s": 20.1},
            "totals": {"requests": 3},
            "hardware": {"gpu_util": 97},
            "requests": [{"file_blobs": 0}],
        }
        seen = {}

        def fake_open(req, timeout):
            seen["authorization"] = req.headers.get("Authorization")
            seen["timeout"] = timeout
            return Response(payload)

        with patch("pulse_agent.urllib.request.urlopen", fake_open):
            result = pulse_agent._strata_api(
                8080, {"api_key": "local-secret, backup-secret"})

        self.assertEqual(seen["authorization"], "Bearer local-secret")
        self.assertEqual(result["model"], "qwen")
        self.assertTrue(result["busy"])
        self.assertNotIn("secret", json.dumps(result))

    def test_snapshot_redaction_covers_nested_processes_and_presets(self):
        secret = "strata-local-secret"
        snapshot = {
            "procs": [{"cmd": f"curl -H 'Bearer {secret}' /v1/models"}],
            "llama": {"presets": [{"args": f"--api-key {secret}"}]},
        }

        clean = pulse_agent._redact_strata_key(snapshot, secret)

        self.assertNotIn(secret, json.dumps(clean))
        self.assertEqual(clean["llama"]["presets"][0]["args"],
                         "--api-key " + pulse_agent.STRATA_KEY_MARKER)


if __name__ == "__main__":
    unittest.main()
