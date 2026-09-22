"""Cross-sectional attention network (optional, requires ``torch``).

Architecture (in the spirit of Kelly-Kuznetsov-Malamud-Xu's *AI asset pricing models* and PatchTST):

1. **Temporal encoder**, shared by all contracts: the last ``seq_len`` bars of features are cut into
   patches of 4 bars, embedded, and passed through a small Transformer encoder; the last token summarises
   each contract's recent history.
2. **Cross-sectional encoder**: a Transformer layer attends *across contracts at the same timestamp*
   (non-members masked), so each forecast is conditioned on what the rest of the market is doing.
3. Linear head -> one score per contract.

The loss is the negative per-timestamp Pearson correlation (IC loss) plus a small MSE anchor: the
portfolio monetises ranking quality, not squared error. Early stopping on validation IC; warm-start from
the previous walk-forward fold keeps retraining cheap.
"""

from __future__ import annotations

import copy

import numpy as np

from hermes.config import DeepConfig

try:  # pragma: no cover - optional dependency
    import torch
    from torch import nn

    TORCH = True
except Exception:  # pragma: no cover
    TORCH = False

PATCH = 4


def available() -> bool:
    return TORCH


if TORCH:

    class _Net(nn.Module):
        def __init__(self, n_features: int, cfg: DeepConfig):
            super().__init__()
            d = cfg.d_model
            self.n_patches = cfg.seq_len // PATCH
            self.patch = nn.Linear(n_features * PATCH, d)
            self.pos = nn.Parameter(torch.zeros(1, self.n_patches, d))
            t_layer = nn.TransformerEncoderLayer(d, cfg.n_heads, 2 * d, cfg.dropout, batch_first=True, norm_first=True)
            self.temporal = nn.TransformerEncoder(t_layer, cfg.n_layers)
            c_layer = nn.TransformerEncoderLayer(d, cfg.n_heads, 2 * d, cfg.dropout, batch_first=True, norm_first=True)
            self.cross = nn.TransformerEncoder(c_layer, 1)
            self.head = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, 1))

        def forward(self, x: torch.Tensor, member: torch.Tensor) -> torch.Tensor:
            # x: (B, N, L, F); member: (B, N) bool
            B, N, L, F = x.shape
            x = x[:, :, L - self.n_patches * PATCH :, :]
            x = x.reshape(B * N, self.n_patches, PATCH * F)
            h = self.patch(x) + self.pos
            h = self.temporal(h)[:, -1, :].reshape(B, N, -1)
            pad = ~member
            all_pad = pad.all(dim=1)
            if all_pad.any():
                pad = pad.clone()
                pad[all_pad, 0] = False
            h = self.cross(h, src_key_padding_mask=pad)
            return self.head(h).squeeze(-1)

    def _ic_loss(score: torch.Tensor, y: torch.Tensor, m: torch.Tensor) -> torch.Tensor:
        mf = m.float()
        n = mf.sum(dim=1).clamp(min=1)
        s_mean = (score * mf).sum(1) / n
        y_mean = (y * mf).sum(1) / n
        sc = (score - s_mean[:, None]) * mf
        yc = (y - y_mean[:, None]) * mf
        corr = (sc * yc).sum(1) / (torch.sqrt((sc**2).sum(1) * (yc**2).sum(1)) + 1e-8)
        valid = n >= 3
        ic = corr[valid].mean() if valid.any() else corr.mean() * 0
        mse = (((score - y) ** 2) * mf).sum() / mf.sum().clamp(min=1)
        return -ic + 0.05 * mse


class DeepModel:
    """Operates on dense arrays: features (T, N, F), membership (T, N), target (T, N)."""

    name = "deep"

    def __init__(self, cfg: DeepConfig):
        if not TORCH:
            raise RuntimeError("torch is not installed: pip install 'hermes[deep]'")
        self.cfg = cfg
        self.net: _Net | None = None
        self.mu: np.ndarray | None = None
        self.sd: np.ndarray | None = None
        self.val_ic = float("nan")

    def _norm(self, X: np.ndarray) -> np.ndarray:
        assert self.mu is not None and self.sd is not None
        Z = (X - self.mu) / self.sd
        return np.clip(np.nan_to_num(Z, nan=0.0, posinf=0.0, neginf=0.0), -5, 5).astype(np.float32)

    def _batch(self, Xn: np.ndarray, member: np.ndarray, t_idx: np.ndarray) -> tuple[torch.Tensor, torch.Tensor]:
        L = self.cfg.seq_len
        wins = np.stack([Xn[t - L + 1 : t + 1] for t in t_idx])  # (B, L, N, F)
        wins = np.transpose(wins, (0, 2, 1, 3))
        return torch.from_numpy(np.ascontiguousarray(wins)), torch.from_numpy(member[t_idx])

    def fit(
        self,
        X: np.ndarray,
        member: np.ndarray,
        y: np.ndarray,
        train_t: np.ndarray,
        val_t: np.ndarray | None = None,
        warm_start: DeepModel | None = None,
    ) -> DeepModel:
        cfg = self.cfg
        torch.manual_seed(cfg.seed)
        rng = np.random.default_rng(cfg.seed)
        L = cfg.seq_len
        train_t = train_t[train_t >= L - 1]
        flat = X[train_t].reshape(-1, X.shape[-1])
        mem = member[train_t].reshape(-1)
        self.mu = np.nan_to_num(np.nanmean(flat[mem], axis=0))
        sd = np.nanstd(flat[mem], axis=0)
        self.sd = np.where(np.isfinite(sd) & (sd > 1e-9), sd, 1.0)
        Xn = self._norm(X)
        yv = np.nan_to_num(y, nan=0.0).astype(np.float32)
        ok = member & np.isfinite(y)
        if warm_start is not None and warm_start.net is not None:
            self.net = copy.deepcopy(warm_start.net)
            epochs = max(2, cfg.epochs // 3)
        else:
            self.net = _Net(X.shape[-1], cfg)
            epochs = cfg.epochs
        opt = torch.optim.AdamW(self.net.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
        best_state, best_ic, bad = None, -np.inf, 0
        for _ in range(epochs):
            self.net.train()
            order = rng.permutation(train_t)
            for s in range(0, len(order), cfg.batch_timestamps):
                idx = order[s : s + cfg.batch_timestamps]
                xb, _ = self._batch(Xn, member, idx)
                mb = torch.from_numpy(ok[idx])
                yb = torch.from_numpy(yv[idx])
                loss = _ic_loss(self.net(xb, mb), yb, mb)
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(self.net.parameters(), 1.0)
                opt.step()
            if val_t is not None and len(val_t):
                ic = self._eval_ic(Xn, member, y, val_t)
                if ic > best_ic:
                    best_ic, best_state, bad = ic, copy.deepcopy(self.net.state_dict()), 0
                else:
                    bad += 1
                    if bad >= cfg.patience:
                        break
        if best_state is not None:
            self.net.load_state_dict(best_state)
            self.val_ic = float(best_ic)
        return self

    @torch.no_grad() if TORCH else (lambda f: f)
    def _scores(self, Xn: np.ndarray, member: np.ndarray, t_idx: np.ndarray) -> np.ndarray:
        assert self.net is not None
        self.net.eval()
        out = np.full((len(t_idx), Xn.shape[1]), np.nan, dtype=np.float32)
        for s in range(0, len(t_idx), 256):
            idx = t_idx[s : s + 256]
            xb, mb = self._batch(Xn, member, idx)
            out[s : s + len(idx)] = self.net(xb, mb).numpy()
        return np.where(member[t_idx], out, np.nan)

    def _eval_ic(self, Xn: np.ndarray, member: np.ndarray, y: np.ndarray, t_idx: np.ndarray) -> float:
        sc = self._scores(Xn, member, t_idx[t_idx >= self.cfg.seq_len - 1])
        yy = y[t_idx[t_idx >= self.cfg.seq_len - 1]]
        ics = []
        for a, b in zip(sc, yy):
            ok = np.isfinite(a) & np.isfinite(b)
            if ok.sum() >= 3 and a[ok].std() > 0 and b[ok].std() > 0:
                ics.append(np.corrcoef(a[ok], b[ok])[0, 1])
        return float(np.mean(ics)) if ics else 0.0

    def predict_dense(self, X: np.ndarray, member: np.ndarray, t_idx: np.ndarray) -> np.ndarray:
        t_idx = np.asarray(t_idx)
        res = np.full((len(t_idx), X.shape[1]), np.nan, dtype=np.float32)
        ok = t_idx >= self.cfg.seq_len - 1
        if ok.any():
            res[ok] = self._scores(self._norm(X), member, t_idx[ok])
        return res
