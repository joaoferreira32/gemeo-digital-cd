"""The Python environment drives the same engine as the app, exactly.

    ai/.venv/Scripts/python ai/test_fidelity.py

An episode is driven through ai/env-server.ts (as the trainer does) and the
same actions are run straight on the engine (ai/direct-episode.ts): the final
fingerprint, the measures and the rewards must match.
"""

import json
import subprocess
import unittest

import numpy as np

from gemeo_env import ROOT, EnvServer, GemeoVecEnv, node_executable


def actions_for(seconds: int) -> list[list[int]]:
    rng = np.random.default_rng(42)
    return rng.integers(0, 5, size=(seconds, 5)).tolist()


class Fidelity(unittest.TestCase):
    def test_same_episode_through_the_server_and_straight_on_the_engine(self):
        for scenario in ("esteira", "caos"):
            with self.subTest(scenario=scenario):
                seed, seconds = 10_777, 120
                actions = actions_for(seconds)
                server = EnvServer()
                try:
                    server.reset(seed, scenario, seconds)
                    total = np.float32(0)
                    for levels in actions:
                        _, reward, done = server.step(np.array(levels))
                        total = np.float32(total + np.float32(reward))
                        if done:
                            break
                    remote = server.result()
                finally:
                    server.close()
                direct = json.loads(subprocess.run(
                    [node_executable(), "--import", "tsx", "ai/direct-episode.ts",
                     json.dumps({"seed": seed, "scenario": scenario, "seconds": seconds,
                                 "actions": actions})],
                    cwd=ROOT, capture_output=True, check=True, text=True).stdout)
                self.assertEqual(remote["fingerprint"], direct["fingerprint"])
                for key in ("delivered", "cycleP95", "cycleP99", "cycleMax", "oldestMax"):
                    self.assertEqual(remote[key], direct[key], key)
                self.assertAlmostEqual(float(total), direct["rewards"], places=2)

    def test_vector_environment_draws_training_seeds_only(self):
        env = GemeoVecEnv(2, seed=1, seconds=5)
        try:
            env.reset()
            seen = []
            for _ in range(12):
                _, _, dones, infos = env.step(np.zeros((2, 5), dtype=np.int64))
                seen += [i["episode"]["seed"] for i, d in zip(infos, dones) if d]
            low, high = env.seed_range
            self.assertTrue(seen)
            self.assertTrue(all(low <= s <= high for s in seen))
            self.assertTrue(all(not 20_001 <= s <= 30_010 for s in seen))
        finally:
            env.close()


if __name__ == "__main__":
    unittest.main()
