"""Python side of the routing environment.

The simulation is the TypeScript engine of the app, headless, behind
ai/env-server.ts: one Node process per environment, binary messages on its
stdin/stdout. Nothing of the simulation is reimplemented here.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
from pathlib import Path
from typing import Any

import gymnasium as gym
import numpy as np
from stable_baselines3.common.vec_env.base_vec_env import VecEnv

ROOT = Path(__file__).resolve().parent.parent
OP_RESET, OP_STEP, OP_INFO, OP_RESULT, OP_CLOSE = 1, 2, 3, 4, 5


def node_executable() -> str:
    """Node from GEMEO_NODE, the PATH, or the portable install of the development machine."""
    found = os.environ.get("GEMEO_NODE") or shutil.which("node")
    if found:
        return found
    portable = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "node.exe"
    if portable.exists():
        return str(portable)
    raise RuntimeError("Node.js not found: set GEMEO_NODE to the node executable")


class EnvServer:
    """One headless engine (a Node process) and its message protocol."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [node_executable(), "--import", "tsx", "ai/env-server.ts"],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            bufsize=0,
        )
        self.info: dict[str, Any] = json.loads(self._request(OP_INFO))
        self.obs_size: int = self.info["observationSize"]

    def _send(self, op: int, payload: bytes = b"") -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(struct.pack("<BI", op, len(payload)) + payload)
        self.proc.stdin.flush()

    def _read(self, n: int) -> bytes:
        assert self.proc.stdout is not None
        out = bytearray()
        while len(out) < n:
            chunk = self.proc.stdout.read(n - len(out))
            if not chunk:
                raise RuntimeError("the engine process stopped answering")
            out += chunk
        return bytes(out)

    def _receive(self) -> bytes:
        (n,) = struct.unpack("<I", self._read(4))
        return self._read(n)

    def _request(self, op: int, payload: bytes = b"") -> bytes:
        self._send(op, payload)
        return self._receive()

    def reset(self, seed: int, scenario: str, seconds: int | None = None,
              reward: dict[str, float] | None = None) -> np.ndarray:
        msg: dict[str, Any] = {"seed": int(seed), "scenario": scenario}
        if seconds is not None:
            msg["seconds"] = int(seconds)
        if reward is not None:
            msg["reward"] = reward
        data = self._request(OP_RESET, json.dumps(msg).encode())
        return np.frombuffer(data, dtype="<f4").copy()

    def step_send(self, levels: np.ndarray) -> None:
        self._send(OP_STEP, np.asarray(levels, dtype=np.uint8).tobytes())

    def step_receive(self) -> tuple[np.ndarray, float, bool]:
        data = self._receive()
        reward, done = struct.unpack("<fB", data[:5])
        return np.frombuffer(data[5:], dtype="<f4").copy(), float(reward), bool(done)

    def step(self, levels: np.ndarray) -> tuple[np.ndarray, float, bool]:
        self.step_send(levels)
        return self.step_receive()

    def result(self) -> dict[str, Any]:
        return json.loads(self._request(OP_RESULT))

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self._send(OP_CLOSE)
            except OSError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        for pipe in (self.proc.stdin, self.proc.stdout):
            if pipe is not None:
                pipe.close()


class GemeoVecEnv(VecEnv):
    """N engines stepped together for Stable-Baselines3.

    Actions go to every engine before any answer is read, so the N Node
    processes simulate in parallel. Each new episode draws a seed from the
    training set only, and a scenario among the four, from its own generator.
    """

    def __init__(self, n_envs: int, seed: int = 0, scenarios: list[str] | None = None,
                 seconds: int = 600, reward: dict[str, float] | None = None) -> None:
        self.servers = [EnvServer() for _ in range(n_envs)]
        info = self.servers[0].info
        self.scenarios = scenarios or list(info["scenarios"])
        self.seed_range = (info["trainingSeeds"]["from"], info["trainingSeeds"]["to"])
        self.seconds = seconds
        self.reward = reward
        self.rng = np.random.default_rng(seed)
        observation_space = gym.spaces.Box(0.0, 2.0, (info["observationSize"],), np.float32)
        action_space = gym.spaces.MultiDiscrete([info["levels"]] * info["decisions"])
        super().__init__(n_envs, observation_space, action_space)
        self._actions: np.ndarray | None = None
        self._returns = np.zeros(n_envs)
        self._lengths = np.zeros(n_envs, dtype=int)
        self.episodes: list[dict[str, Any]] = [{} for _ in range(n_envs)]

    def _new_episode(self, i: int) -> np.ndarray:
        seed = int(self.rng.integers(self.seed_range[0], self.seed_range[1] + 1))
        scenario = str(self.rng.choice(self.scenarios))
        self.episodes[i] = {"seed": seed, "scenario": scenario}
        self._returns[i] = 0.0
        self._lengths[i] = 0
        return self.servers[i].reset(seed, scenario, self.seconds, self.reward)

    def reset(self) -> np.ndarray:
        return np.stack([self._new_episode(i) for i in range(self.num_envs)])

    def step_async(self, actions: np.ndarray) -> None:
        self._actions = np.asarray(actions)
        for i, server in enumerate(self.servers):
            server.step_send(self._actions[i])

    def step_wait(self):
        observations, rewards, dones, infos = [], [], [], []
        for i, server in enumerate(self.servers):
            obs, reward, done = server.step_receive()
            self._returns[i] += reward
            self._lengths[i] += 1
            info: dict[str, Any] = {}
            if done:
                info["episode"] = {"r": float(self._returns[i]), "l": int(self._lengths[i]),
                                   **self.episodes[i]}
                info["terminal_observation"] = obs
                obs = self._new_episode(i)
            observations.append(obs)
            rewards.append(reward)
            dones.append(done)
            infos.append(info)
        return np.stack(observations), np.asarray(rewards, dtype=np.float32), np.asarray(dones), infos

    def close(self) -> None:
        for server in self.servers:
            server.close()

    # Parts of the VecEnv interface this environment does not need.
    def get_attr(self, attr_name, indices=None):
        return [getattr(self, attr_name, None) for _ in self._indices(indices)]

    def set_attr(self, attr_name, value, indices=None) -> None:
        setattr(self, attr_name, value)

    def env_method(self, method_name, *args, indices=None, **kwargs):
        return [None for _ in self._indices(indices)]

    def env_is_wrapped(self, wrapper_class, indices=None):
        return [False for _ in self._indices(indices)]

    def _indices(self, indices):
        if indices is None:
            return range(self.num_envs)
        if isinstance(indices, int):
            return [indices]
        return indices
