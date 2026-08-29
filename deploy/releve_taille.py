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


def _livre(d: dict) -> None:
    """Ou part l argent, sur la vie entiere du compte.

    L equite seule ne dit pas si un recul vient du marche, des frais ou du
    financement. Le compte a recule de 6,4 % pendant que la regle mesuree
    affichait -0,22 bps sur 53 trades : a quelques centaines de dollars de
    notionnel, cela fait des cents, pas des centaines de dollars. Le reste
    vient forcement d ailleurs, et sans ce bloc on ne peut que le deviner.

    L identite boucle : depart + brut - frais - financement + latent =
    equite. Un ecart non nul veut dire qu il manque un poste.
    """
    lv = d.get("livre")
    if not isinstance(lv, dict) or not lv:
        print("pas de livre dans ce releve (moteur anterieur)")
        print()
        return
    dep = float(lv.get("depart") or 0.0)
    eq = float(lv.get("equite") or 0.0)
    brut = float(lv.get("brut") or 0.0)
    frais = float(lv.get("frais") or 0.0)
    fund = float(lv.get("funding") or 0.0)
    notion = float(lv.get("notionnel") or 0.0)
    n = int(lv.get("n") or 0)
    avant = float(lv.get("avant") or 0.0)
    latent = eq - (dep + avant + brut - frais - fund)
    print("ou part l argent, vie entiere du compte")
    print(f"  depart         {dep:>+12.2f} USD")
    if avant:
        print(f"  avant le livre {avant:>+12.2f} USD   (non decompose)")
    print(f"  brut realise   {brut:>+12.2f} USD")
    print(f"  frais          {-frais:>+12.2f} USD"
          + (f"   ({frais / notion * 1e4:.2f} bps sur {notion:,.0f} traites)"
             if notion > 0 else ""))
    print(f"  financement    {-fund:>+12.2f} USD")
    print(f"  latent         {latent:>+12.2f} USD")
    print(f"  equite         {eq:>+12.2f} USD   "
          f"({(eq / dep - 1.0) * 100:+.2f} % en {n} fills)")
    if int(lv.get("liq") or 0):
        print(f"  LIQUIDATIONS   {int(lv['liq'])}")
    # Le chiffre qui tranche : les frais paient-ils plus que le marche ne
    # prend ? Si oui, le probleme est le nombre de trades, pas le signal.
    if frais > 0 and abs(brut) < frais:
        print("  -> les frais dominent le brut : c est un moulin, pas un pari")
    print()


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
        n, tot, usd, gag = par.get(motif, (0, 0.0, 0.0, 0))
        net = float(t["net_bps"])
        par[motif] = (n + 1, tot + net,
                      usd + net * 1e-4 * abs(float(t.get("notional") or 0.0)),
                      gag + (1 if net > 0 else 0))
    # La PART GAGNANTE, par motif. Elle manquait pour chiffrer un ecart
    # precis : la porte facture 4,75 bps — le prix dun take pose au
    # carnet — a toute jambe SUIVEUSE gagnante a lhorizon, alors quune
    # cellule suiveuse na pas de take et sort au time-stop, en taker, a
    # 7,0. Lecart vaut 2,25 bps par jambe concernee, et cest cette part
    # qui dit combien de jambes sont concernees.
    print(f"attribution sur les {len(fermes)} dernieres fermetures mesurees")
    print(f"  {'motif':<12} {'n':>4} {'bps/trade':>10} {'USD':>9} {'gagnantes':>11}")
    for motif, (n, tot, usd, gag) in sorted(par.items(), key=lambda kv: -kv[1][2]):
        print(f"  {motif:<12} {n:>4} {tot / n:>+10.1f} {usd:>+9.2f}"
              f" {gag:>4}/{n:<3} {gag / n * 100:>3.0f}%")
    n = len(fermes)
    tot = sum(float(t["net_bps"]) for t in fermes)
    usd = sum(float(t["net_bps"]) * 1e-4 * abs(float(t.get("notional") or 0.0))
              for t in fermes)
    gag = sum(1 for t in fermes if float(t["net_bps"]) > 0)
    print(f"  {'TOTAL':<12} {n:>4} {tot / n:>+10.1f} {usd:>+9.2f}"
          f" {gag:>4}/{n:<3} {gag / n * 100:>3.0f}%")
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
    jambes = int(reg.get("jambes") or 0)
    print(f"fonds propres {eq:.2f}   frein {d.get('frein_risque', 1.0):.2f}"
          f"   confiance {float(reg.get('confiance') or 0.0):.2f}"
          f"   direct n={reg.get('n', 0)} bps={float(reg.get('bps') or 0.0):+.1f}"
          + (f" ({jambes} jambes)" if jambes else "")
          # La MEME mesure en unites de risque, en parallele. La moyenne
          # equiponderee en bps decrit un livre a notionnel constant ; le
          # moteur en tient un a risque constant. Les 29 fermetures du
          # 27 aout donnaient -4,7 bps par trade pour +0,94 USD, ce qui
          # est exactement ce que produit cet ecart. Les deux series
          # coincident sur les instants a une seule jambe et ne divergent
          # que la ou elles doivent.
          + ((f"   en risque n={int(reg.get('n_risque') or 0)} "
              f"bps={float(reg.get('bps_risque') or 0.0):+.1f}")
             if int(reg.get("n_risque") or 0) else ""))
    # n compte des INSTANTS de portefeuille, pas des jambes : la porte
    # valide le portefeuille que l horloge tient a chaque instant, et
    # compter chaque jambe separement gonflerait la confiance qu on croit
    # avoir. Le nombre de jambes reste affiche : l information n est pas
    # perdue, elle cesse seulement d etre comptee comme independante.
    # Le frein de MESURE, a cote du frein de capital. Je les avais ajoutes
    # au snapshot sans les afficher nulle part : deux mesures muettes,
    # exactement le defaut que le compteur de refus vient de corriger
    # ailleurs. Une quantite qui ne se lit pas ne sert a rien.
    fm = d.get("frein_mesure")
    if fm is not None:
        td = float(d.get("t_direct") or 0.0)
        nc = int(reg.get("n_carre") or 0)
        print(f"frein de mesure {float(fm):.2f}"
              f"   t direct {td:+.2f} sigma"
              f"   dispersion sur {nc} instants"
              + ("   (inerte : moins de 30)" if nc < 30 else ""))
    n_e = int(ent.get("n_entrees") or 0)
    if n_e:
        print(f"retard entre la cible et lordre {float(ent.get('retard_s') or 0.0):.1f} s "
              f"sur {n_e} ordres")
    # Le retard QUI COMPTE, et qui manquait a ce releve : entre la
    # CLOTURE de la barre qui decide et la decision. La porte simule
    # zero ; le journal du 27 aout donne vingt-six secondes sur la 1m et
    # cent cinquante-deux sur la 15m. Le releve affichait 0,3 s et
    # laissait croire lexecution immediate.
    n_b = int(ent.get("n_retard_barre") or 0)
    if n_b:
        par = ent.get("retard_par_barre") or {}
        det = "  ".join(f"{b} {float(v[0]):.0f}s"
                        for b, v in sorted(par.items()) if int(v[1]) > 0)
        print(f"retard sur la cloture de barre "
              f"{float(ent.get('retard_barre_s') or 0.0):.0f} s "
              f"sur {n_b} decisions (la porte en simule 0)"
              + (f"   {det}" if det else ""))
    # Les allers-retours payes pour REPRENDRE une jambe soldee au temps.
    # Journal du 27 aout : XRP -900 solde et -902 rouvert la MEME seconde.
    n_o = int(ent.get("n_ouvre") or 0)
    n_r = int(ent.get("n_rouvre") or 0)
    if n_o:
        print(f"jambes reprises dans la barre {n_r} sur {n_o} ouvertures"
              f"   {float(ent.get('usd_rouvre') or 0.0):,.0f} USD de"
              f" notionnel qui repaie un aller-retour")
    # Ce que la regle PROPOSE contre ce qu elle obtient. La porte met
    # vingt noms en commun et le livre en tient zero a deux : sans cette
    # ligne, l ecart entre le livre valide et le livre joue ne se lit
    # nulle part. « deja tenue » n est PAS un refus — la jambe est la, a
    # la taille voulue, et il n y a rien a faire.
    n_v = int(ent.get("n_vise") or 0)
    if n_v:
        pl = int(ent.get("refus_plancher") or 0)
        motifs = "  ".join(
            f"{m} {int(ent.get('refus_' + m) or 0)}"
            for m in ("plancher", "arrondi", "prix", "rejet")
            if int(ent.get("refus_" + m) or 0))
        print(f"jambes visees par la regle {n_v}"
              f"   ouvertes ou redimensionnees {int(ent.get('n_ordre') or 0)}"
              f"   deja tenues {int(ent.get('n_deja') or 0)}"
              + (f"   refusees: {motifs}" if motifs else "   aucun refus"))
        if pl:
            print(f"  dont {pl} jambes sous le plancher dordre"
                  f" (max 10 USD ou 0,2 % des fonds propres) :"
                  f" {float(ent.get('usd_refus_plancher') or 0.0):,.0f}"
                  f" USD de notionnel jamais ouvert")
    n_g = int(ent.get("n_gliss") or 0)
    if n_g:
        gl = float(ent.get("glissement_bps") or 0.0)
        facture = max(0.0, gl) if n_g >= 30 else 0.0
        med = float(ent.get("gliss_med") or 0.0)
        print(f"glissement dentree mesure {gl:+.2f} bps sur {n_g} ouvertures"
              f" (mediane {med:+.2f})"
              f"  -> facture a la porte {facture:+.2f} bps"
              + ("" if n_g >= 30 else "  (moins de 30, pas encore facture)"))
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
    _livre(d)
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
