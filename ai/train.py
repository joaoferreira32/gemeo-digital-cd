"""Trains the routing agent with PPO on the headless TypeScript engine.

    ai/.venv/Scripts/python ai/train.py --name rodada1 --steps 2000000

Writes ai/runs/<name>/ (training log, model.zip; not versioned) and
ai/models/<name>.onnx with ai/models/<name>.json (versioned: what the app and
the benchmark load). Seeds come from the training set only; the tuning
rounds are judged on the validation seeds by `npm run bench:rotas -- --rl`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.logger import configure
from stable_baselines3.common.vec_env import VecNormalize

from gemeo_env import ROOT, GemeoVecEnv


class EpisodeLog(BaseCallback):
    """Keeps every finished episode (seed, scenario, return) for the run report."""

    def __init__(self) -> None:
        super().__init__()
        self.episodes: list[dict] = []

    def _on_step(self) -> bool:
        for info in self.locals["infos"]:
            if "episode" in info:
                self.episodes.append({**info["episode"], "step": int(self.num_timesteps)})
        return True


class Logits(torch.nn.Module):
    """The deterministic policy as a plain network: observation → 25 logits."""

    def __init__(self, policy) -> None:
        super().__init__()
        self.policy = policy

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        p = self.policy
        latent = p.mlp_extractor.forward_actor(p.extract_features(obs, p.pi_features_extractor))
        return p.action_net(latent)


def export(policy, name: str, info: dict, extra: dict) -> Path:
    """Writes ai/models/<name>.onnx and <name>.json (sizes, training facts, parity probe)."""
    models = ROOT / "ai" / "models"
    models.mkdir(parents=True, exist_ok=True)
    net = Logits(policy).eval()
    onnx_path = models / f"{name}.onnx"
    torch.onnx.export(net, torch.zeros(1, info["observationSize"]), str(onnx_path),
                      input_names=["obs"], output_names=["logits"],
                      dynamic_axes={"obs": {0: "n"}}, opset_version=17, dynamo=False)
    # Fixtures for the parity test of the browser runtime: observations and the logits PyTorch gives.
    rng = np.random.default_rng(0)
    probe = rng.random((8, info["observationSize"]), dtype=np.float32)
    with torch.no_grad():
        logits = net(torch.from_numpy(probe)).numpy()
    meta = {
        "name": name,
        "observationSize": info["observationSize"],
        "decisions": info["decisions"],
        "levels": info["levels"],
        **extra,
        "probe": {"observations": probe.tolist(), "logits": logits.tolist()},
    }
    (models / f"{name}.json").write_text(json.dumps(meta, indent=1), encoding="utf-8",
                                         newline="\n")
    return onnx_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--steps", type=int, default=2_000_000)
    ap.add_argument("--envs", type=int, default=16)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--per-packet", type=float, default=None)
    ap.add_argument("--per-old-packet", type=float, default=None)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--ent", type=float, default=0.01)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # the Windows console defaults to cp1252
    # The engines are separate processes; one PyTorch thread leaves the cores to them.
    torch.set_num_threads(1)

    reward = None
    if args.per_packet is not None or args.per_old_packet is not None:
        reward = {"perPacket": args.per_packet if args.per_packet is not None else 0.01,
                  "perOldPacket": args.per_old_packet if args.per_old_packet is not None else 0.05}

    run_dir = ROOT / "ai" / "runs" / args.name
    run_dir.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(args.seed)
    venv = GemeoVecEnv(args.envs, seed=args.seed, reward=reward)
    info = venv.servers[0].info
    env = VecNormalize(venv, norm_obs=False, norm_reward=True, gamma=0.99)
    n_steps = 256
    model = PPO(
        "MlpPolicy", env, n_steps=n_steps, batch_size=n_steps * args.envs // 4, n_epochs=10,
        learning_rate=args.lr,
        gamma=0.99, gae_lambda=0.95, clip_range=0.2, ent_coef=args.ent,
        policy_kwargs={"net_arch": {"pi": [128, 128], "vf": [128, 128]}},
        seed=args.seed, device="cpu", verbose=0,
    )
    model.set_logger(configure(str(run_dir), ["csv", "stdout"]))
    log = EpisodeLog()
    t0 = time.time()
    model.learn(total_timesteps=args.steps, callback=log)
    wall = time.time() - t0
    model.save(run_dir / "model.zip")
    env.close()

    last = log.episodes[-200:]
    onnx_path = export(model.policy, args.name, info, {
        "algorithm": "PPO (Stable-Baselines3)",
        "steps": args.steps,
        "envs": args.envs,
        "seed": args.seed,
        "learningRate": args.lr,
        "entropy": args.ent,
        "reward": reward or info["reward"],
        "trainingSeeds": info["trainingSeeds"],
        "scenarios": info["scenarios"],
        "wallSeconds": round(wall),
        "decisionsPerSecond": round(args.steps / wall),
        "episodes": len(log.episodes),
        "meanReturnLast200": float(np.mean([e["r"] for e in last])) if last else None,
    })
    (run_dir / "episodes.json").write_text(json.dumps(log.episodes), encoding="utf-8")
    print(f"\n{args.name}: {args.steps} decisões em {wall / 60:.1f} min "
          f"({args.steps / wall:.0f}/s) → {onnx_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
