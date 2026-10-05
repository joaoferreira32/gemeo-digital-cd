"""Trains the routing agent with PPO on the headless TypeScript engine.

    ai/.venv/Scripts/python ai/train.py --name rodada1 --steps 2000000
    ai/.venv/Scripts/python ai/train.py --name rodada2 --imitate 400 --lr 1e-4 --ent 0.001 --clip 0.1

Writes ai/runs/<name>/ (training log, model.zip; not versioned) and
ai/models/<name>.onnx with ai/models/<name>.json (versioned: what the app and
the benchmark load). Seeds come from the training set only; the tuning
rounds are judged on the validation seeds by `npm run bench:rotas -- --rl`.

--imitate N starts from the heuristic instead of from random weights: N
episodes of the heuristic teacher (ai/dataset.ts, training seeds) teach the
policy network by plain supervised learning, then PPO trains only the value
network for the first --warmup updates (a critic that knows nothing yet
would push the policy around) and goes on with both. The network as it is
after imitation alone is exported too (<name>-imitacao), so the benchmark
shows what PPO added on top of it.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.logger import configure
from stable_baselines3.common.vec_env import VecNormalize

from gemeo_env import ROOT, GemeoVecEnv, build_engine, node_executable


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


def actor_parameters(policy) -> list[torch.nn.Parameter]:
    return list(policy.mlp_extractor.policy_net.parameters()) + list(policy.action_net.parameters())


class CriticWarmup(BaseCallback):
    """Trains only the value network for the first updates (the policy stays frozen)."""

    def __init__(self, updates: int) -> None:
        super().__init__()
        self.left = updates

    def _set(self, trainable: bool) -> None:
        for q in actor_parameters(self.model.policy):
            q.requires_grad_(trainable)

    def _on_training_start(self) -> None:
        if self.left > 0:
            self._set(False)

    def _on_rollout_end(self) -> None:
        if self.left > 0:
            self.left -= 1
            if self.left == 0:
                self._set(True)

    def _on_step(self) -> bool:
        return True


def demonstrations(episodes: int, out: Path, seed: int, observation_size: int,
                   decisions: int, procs: int = 14) -> dict[str, np.ndarray]:
    """Episodes of the heuristic teacher on training seeds, in parallel shards (ai/dataset.ts)."""
    build_engine()
    out.mkdir(parents=True, exist_ok=True)
    per = -(-episodes // procs)
    first = 15_001  # any training seeds; PPO draws its own from the whole set
    shards = []
    for k in range(procs):
        n = min(per, episodes - k * per)
        if n <= 0:
            break
        cfg = {"from": first + k * per, "episodes": n, "seed": seed * 1000 + k, "out": str(out / str(k))}
        shards.append(subprocess.Popen([node_executable(), "build/headless/ai/dataset.js", json.dumps(cfg)],
                                       cwd=ROOT))
    for proc in shards:
        if proc.wait() != 0:
            raise RuntimeError("a demonstration shard failed")
    read = lambda k, ext, dtype: np.fromfile(out / f"{k}.{ext}", dtype=dtype)
    return {
        "obs": np.concatenate([read(k, "obs", "<f4") for k in range(len(shards))]).reshape(-1, observation_size),
        "act": np.concatenate([read(k, "act", "u1") for k in range(len(shards))]).reshape(-1, decisions),
        "done": np.concatenate([read(k, "done", "u1") for k in range(len(shards))]),
    }


def imitate(policy, data: dict[str, np.ndarray], epochs: int = 8, batch: int = 1024,
            lr: float = 1e-3, seed: int = 0) -> dict[str, float]:
    """Supervised start: the policy network learns the teacher's levels (cross-entropy)."""
    obs = torch.from_numpy(data["obs"])
    act = torch.from_numpy(data["act"].astype(np.int64))
    # Hold out the last tenth of the episodes (whole episodes: steps of one episode are alike).
    ends = np.flatnonzero(data["done"])
    cut = int(ends[int(len(ends) * 0.9) - 1]) + 1
    rng = np.random.default_rng(seed)
    opt = torch.optim.Adam(actor_parameters(policy), lr=lr)
    for _ in range(epochs):
        for i in np.array_split(rng.permutation(cut), max(1, cut // batch)):
            loss = -policy.get_distribution(obs[i]).log_prob(act[i]).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
    with torch.no_grad():
        logits = Logits(policy)(obs[cut:])
        guess = logits.reshape(len(logits), act.shape[1], -1).argmax(dim=2)
        right = guess == act[cut:]
    return {"samples": int(cut), "heldOut": int(len(obs) - cut),
            "levelAccuracy": float(right.float().mean()), "allFiveAccuracy": float(right.all(dim=1).float().mean())}


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
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--imitate", type=int, default=0, help="episodes of heuristic demonstrations (0: random start)")
    ap.add_argument("--warmup", type=int, default=10, help="updates of the value network alone after imitation")
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
        gamma=0.99, gae_lambda=0.95, clip_range=args.clip, ent_coef=args.ent,
        policy_kwargs={"net_arch": {"pi": [128, 128], "vf": [128, 128]}},
        seed=args.seed, device="cpu", verbose=0,
    )
    model.set_logger(configure(str(run_dir), ["csv", "stdout"]))
    imitation = None
    callbacks: list[BaseCallback] = [log := EpisodeLog()]
    if args.imitate:
        t = time.time()
        data = demonstrations(args.imitate, run_dir / "demos", args.seed, info["observationSize"],
                              info["decisions"])
        imitation = {"episodes": args.imitate, **imitate(model.policy, data, seed=args.seed),
                     "seconds": round(time.time() - t), "warmupUpdates": args.warmup}
        print(f"imitação: {json.dumps(imitation)}", flush=True)
        export(model.policy, f"{args.name}-imitacao", info, {
            "algorithm": "imitação da heurística, sem PPO", "seed": args.seed, "imitation": imitation,
        })
        callbacks.append(CriticWarmup(args.warmup))
    t0 = time.time()
    model.learn(total_timesteps=args.steps, callback=callbacks)
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
        "clip": args.clip,
        "imitation": imitation,
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
