# ⛔ BRANCHE MORTE — FAUSSE DIRECTION — NE PAS UTILISER

Cette branche correspond à une ancienne piste de déploiement VPS abandonnée avant le choix du worker Render 24/7.

- Zenith utilise la direction Render définie dans `main`.
- Ne pas utiliser les services systemd/VPS, fichiers d'environnement ou watchdog de cette branche.
- Ne pas fusionner, cherry-pick ou reprendre ce runtime comme base.
- La source officielle et exécutable de Zenith est la branche `main`.
- Toute future modification du runtime serveur doit partir de `main` uniquement et respecter le bloc 6 verrouillé.

Audit ménage : 2026-09-29.