"""Redoes round 2's imitation from scratch and compares it with the committed network.

    ai/.venv/Scripts/python ai/check_imitation.py

Same as `train.py --imitate 400 --seed 2` up to the export of the imitated
network: the same 400 demonstrations of the heuristic teacher (training seeds
from 15 001), the same model and the same supervised step. The ONNX it exports
(to a temporary folder) must be byte for byte ai/models/rodada2-imitacao.onnx.
About 3 minutes; exit code 1 when they differ.
"""

from __future__ import annotations

import hashlib
import sys
import tempfile
from pathlib import Path

import torch
from stable_baselines3.common.vec_env import VecNormalize

from gemeo_env import ROOT, GemeoVecEnv
from train import demonstrations, export, imitate, new_model

ENVS, SEED, EPISODES = 16, 2, 400


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    torch.set_num_threads(1)
    committed = ROOT / "ai" / "models" / "rodada2-imitacao.onnx"
    with tempfile.TemporaryDirectory() as folder:
        tmp = Path(folder)
        torch.manual_seed(SEED)
        venv = GemeoVecEnv(ENVS, seed=SEED)
        info = venv.servers[0].info
        model = new_model(VecNormalize(venv, norm_obs=False, norm_reward=True, gamma=0.99),
                          ENVS, SEED, lr=1e-4, ent=0.001, clip=0.1)
        venv.close()
        data = demonstrations(EPISODES, tmp / "demos", SEED, info["observationSize"], info["decisions"])
        stats = imitate(model.policy, data, seed=SEED)
        fresh = export(model.policy, "reproducao", info, {}, models=tmp).read_bytes()
    old = committed.read_bytes()
    digest = lambda b: hashlib.sha256(b).hexdigest()[:16]
    print(f"acurácia da imitação: {stats['levelAccuracy']:.4f} nos níveis, {stats['allFiveAccuracy']:.4f} nas cinco")
    print(f"refeita agora:  sha256 {digest(fresh)} ({len(fresh)} bytes)")
    print(f"commitada:      sha256 {digest(old)} ({len(old)} bytes)")
    same = fresh == old
    print("idêntica bit a bit" if same else "DIFERENTE")
    return 0 if same else 1


if __name__ == "__main__":
    sys.exit(main())
