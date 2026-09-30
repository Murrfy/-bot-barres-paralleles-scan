# ZENITH — SCHÉMA MAÎTRE DU PROJET

> **RÈGLE DE GOUVERNANCE**
>
> Ce schéma est la feuille de route officielle de Zénith.
> Il ne doit pas être supprimé, réécrit, réordonné ou remplacé sans accord explicite de Walter.
> Toute nouvelle conversation / tout nouveau chapitre doit le lire AVANT toute analyse ou modification.
> La branche `main` reste l’unique vérité exécutable du projet.
> Les anciennes branches ne sont jamais une source de vérité.

## Ordre officiel des chapitres

1. Interface utilisateur
2. Paramètres BOT / jeton
3. Sortie / risque
4. Cycle d’un jeton
5. Moteur Zénith 24/24
6. Exécution Binance
7. MASTER / ADMIN / CONTRÔLEUR
8. État / synchronisation / historique
9. Notifications et suivi
10. Tests et validation finale

L’ordre est obligatoire. Ne pas sauter à un chapitre suivant parce qu’un problème y ressemble.

## Méthode obligatoire pour chaque chapitre

1. Partir uniquement du `main` actuel.
2. Lire ce fichier puis `zenith-chapter-scope.json`.
3. Travailler uniquement sur le chapitre actif indiqué par `zenith-chapter-scope.json`.
4. Comprendre le comportement existant AVANT de proposer une correction.
5. Identifier les fichiers réellement utilisés et leurs dépendances à partir du `main`.
6. Lancer les tests AVANT modification.
7. Si quelque chose est rouge, diagnostiquer d’abord la cause réelle. Ne pas corriger au hasard.
8. Ne modifier aucun fichier hors du périmètre autorisé du chapitre.
9. Ne pas réintroduire une ancienne architecture, un ancien fichier ou une ancienne règle depuis une vieille branche.
10. Après modification : tests ciblés, puis Zenith Safety Checks et CodeQL.
11. Aucun chapitre n’est terminé tant que les contrôles nécessaires ne sont pas verts.
12. Après validation et fusion dans `main`, seulement alors passer au chapitre suivant.

## Anciennes branches

Les anciennes branches servent uniquement d’archive de comparaison.

Interdictions :
- ne jamais repartir d’une ancienne branche ;
- ne jamais fusionner une ancienne branche entière dans le projet courant ;
- ne jamais restaurer un ancien fichier entier simplement parce qu’il contenait autrefois une fonction ;
- ne jamais considérer une branche comme plus vraie que `main`.

Si une correction semble manquer dans `main`, comparer précisément cette correction avec `main`, prouver qu’elle manque encore et récupérer uniquement le changement nécessaire.

## Verrouillage du chapitre actif

Le fichier `zenith-chapter-scope.json` définit :
- le chapitre actif ;
- la révision du périmètre ;
- les seuls chemins autorisés.

Le contrôle `scripts/check-chapter-scope.mjs` est exécuté par Zenith Safety Checks.

Une PR qui touche un fichier hors du chapitre actif doit échouer.

Pour changer de chapitre :
1. modifier uniquement `zenith-chapter-scope.json` ;
2. augmenter `scopeRevision` ;
3. fusionner ce changement isolé ;
4. seulement ensuite commencer le nouveau chapitre.

## Règles métier déjà verrouillées à préserver

Les règles déjà inscrites dans le code, les tests et les blocs verrouillés restent prioritaires.
Un nouveau chapitre ne doit pas les réinterpréter sous prétexte de simplification.

En particulier :
- pas de retour aux anciens concepts abandonnés de scan / barres / SUP-MED-INF ;
- pas de plafond fixe de trois positions ;
- ventes LIMIT uniquement, sans fallback MARKET ;
- MAX-LOSS = perte / STOP-LOSS, distinct des protections de gains ;
- ne pas restaurer un ancien comportement simplement parce qu’il existe sur une vieille branche.

## Instruction minimale à donner à un nouveau chapitre

« Travaille sur le dépôt `Murrfy/-bot-barres-paralleles-scan`. Pars uniquement de `main`. Lis d’abord `ZENITH_MASTER_PLAN.md` puis `zenith-chapter-scope.json`. Respecte strictement le chapitre actif, son périmètre et les tests. N’utilise jamais une ancienne branche comme base de travail. Ne passe au chapitre suivant qu’après validation et fusion du chapitre courant. »
