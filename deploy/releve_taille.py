"""Pourquoi la position fait CETTE taille-la, et pas une autre.

« Il ouvre des micro positions pourries » est une observation sur une
taille. Le releve savait dire quelle regle avait decide et quel avantage
elle annoncait, jamais ce qui avait reduit la taille entre les deux. Or
la chaine compte six etages — avantage mesure, borne basse de Kelly,
frein du gouverneur, rodage, plafond par nom, plafond brut — et chacun
peut a lui seul faire passer une conviction de seize pour cent de fonds
propres a deux. Sans le detail, « la regle est prudente » et « un etage
annule tout » se ressemblent trop.
"""
import json
import sys

CHEMIN = "/root/hermes/state/scalp.json"


def _attribution(trades: list) -> None:
    """Ou part l argent, par motif de sortie.

    « Il fait n importe quoi » est une accusation sur la maniere dont les
    positions se ferment, et le journal ne portait que des prix : il
    fallait reapparier a la main entrees et sorties, et une sortie par
    stop ne se distinguait pas d une sortie a l horizon mesure. Chaque
    fermeture de regle mesuree porte maintenant son resultat.
    """
    fermes = [t for t in trades if isinstance(t, dict)
              and t.get("net_bps") is not None]
    if not fermes:
        print("aucune fermeture mesuree dans la fenetre gardee")
        print()
        return
    par = {}
    for t in fermes:
        motif = str(t.get("reason") or "?").split()[0]
        n, tot, usd = par.get(motif, (0, 0.0, 0.0))
        net = float(t["net_bps"])
        par[motif] = (n + 1, tot + net,
                      usd + net * 1e-4 * abs(float(t.get("notional") or 0.0)))
    print(f"attribution sur les {len(fermes)} dernieres fermetures mesurees")
    print(f"  {'motif':<12} {'n':>4} {'bps/trade':>10} {'USD':>9}")
    for motif, (n, tot, usd) in sorted(par.items(), key=lambda kv: -kv[1][2]):
        print(f"  {motif:<12} {n:>4} {tot / n:>+10.1f} {usd:>+9.2f}")
    n = len(fermes)
    tot = sum(float(t["net_bps"]) for t in fermes)
    usd = sum(float(t["net_bps"]) * 1e-4 * abs(float(t.get("notional") or 0.0))
              for t in fermes)
    print(f"  {'TOTAL':<12} {n:>4} {tot / n:>+10.1f} {usd:>+9.2f}")
    print()


def main() -> int:
    try:
        with open(sys.argv[1] if len(sys.argv) > 1 else CHEMIN) as f:
            d = json.load(f)
    except (OSError, ValueError) as exc:
        print(f"pas de releve lisible: {type(exc).__name__}")
        return 0

    eq = float(d.get("equity") or 0.0)
    lev = d.get("lev") or {}
    reg = d.get("live_rule") or {}
    ent = d.get("entree") or {}
    print(f"fonds propres {eq:.2f}   frein {d.get('frein_risque', 1.0):.2f}"
          f"   confiance {float(reg.get('confiance') or 0.0):.2f}"
          f"   direct n={reg.get('n', 0)} bps={float(reg.get('bps') or 0.0):+.1f}")
    n_e = int(ent.get("n_entrees") or 0)
    if n_e:
        print(f"retard dentree mesure {float(ent.get('retard_s') or 0.0):.1f} s "
              f"sur {n_e} ordres  (la porte suppose 0)")
    print(f"plafonds: par nom {lev.get('name_cap')}  brut {lev.get('gross_cap')}"
          f"  utilise {float(lev.get('used') or 0.0):.3f}")
    # Le plafond de ruine — 2,5 % de fonds propres par stop touche — borne
    # le levier AVANT le frein et le rodage. Quand il mord, baisser le
    # frein ne change plus rien a la taille : c est lui qui decide.
    print("colonne « defl » = le net une fois otee la prime de selection"
          " (max sur ~1300 cellules) ; cest LUI qui dimensionne")
    print("colonne « USD plein » = la taille que l avantage seul justifie,"
          " frein et rodage retires, plafond de ruine compris")
    print()
    # La colonne qui repond a « il ouvre des micro positions » : ce que
    # l avantage seul justifierait, avant que le frein et le rodage ne
    # multiplient. Tant que les deux chiffres ne sont pas cote a cote,
    # « la regle est faible » et « la regle est bridee » se ressemblent.
    _attribution(d.get("trades") or [])
    print(f"{'inst':<6} {'pol':<7} {'dir':<5} {'h':>2} {'edge':>7} "
          f"{'net':>7} {'sd':>6} {'n':>5} {'defl':>7} {'poids':>8} "
          f"{'USD':>9} {'USD plein':>10}")
    for p in (d.get("preds") or []):
        if (p.get("dir") or "flat") == "flat":
            continue
        net = float(p.get("net_bps") or 0.0)
        sd = float(p.get("net_sd") or 0.0)
        n = int(p.get("net_n") or 0)
        defl = float(p.get("net_defl") or 0.0)
        if defl <= 0.0:
            defl = net - (sd / (n ** 0.5)) if (sd > 0 and n > 0) else net
        w = float(p.get("lev") or 0.0)
        plein = float(p.get("poids_plein") or 0.0)
        print(f"{(p.get('inst') or '').split('-')[0]:<6} "
              f"{str(p.get('policy'))[:7]:<7} {str(p.get('dir'))[:5]:<5} "
              f"{int(p.get('h_bars') or 0):>2} "
              f"{float(p.get('edge_bps') or 0.0):>+7.1f} "
              f"{net:>+7.1f} {sd:>6.1f} {n:>5} {defl:>+7.1f} "
              f"{w:>+8.4f} {w * eq:>+9.0f} {plein * eq:>+10.0f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
