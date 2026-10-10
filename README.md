# SunuÉcole Pro — SaaS multi-écoles de gestion scolaire

Node.js + Express + PostgreSQL. Interface web dans `public/`.

## Fonctionnement
- Une école intéressée clique sur **« Inscrire mon école »** : cela crée l'école et son compte **Directeur**.
- L'école reçoit un **code** (ex. `college-alpha`). Tous ses utilisateurs se connectent avec : code d'école + identifiant + mot de passe.
- Le Directeur crée ses utilisateurs (secrétariat, caisse, comptable, enseignants, personnalisé) et **coche, utilisateur par utilisateur, les habilitations** (voir `permissions.js`). Les changements s'appliquent immédiatement.
- Les données de chaque école sont cloisonnées (toutes les requêtes sont filtrées par école).
- Le compte **superadmin (KMS)** se connecte avec le code d'école vide ; il voit les écoles inscrites, peut suspendre un abonnement et réinitialiser le mot de passe d'un Directeur.

## Déploiement sur Render
1. Mettre ce dossier dans un dépôt GitHub (`node_modules` et `.env` sont ignorés).
2. Render → **New → Blueprint** → choisir le dépôt (le fichier `render.yaml` crée le service web + la base PostgreSQL).
3. Saisir `SUPERADMIN_PASSWORD` (10 caractères minimum) quand Render le demande. `JWT_SECRET` est généré automatiquement.
4. Une fois en ligne, ouvrir l'URL : « Inscrire mon école » pour les écoles ; connexion KMS avec le code d'école **vide**, l'identifiant `kms` et votre mot de passe.

## En local
    # PostgreSQL requis
    export DATABASE_URL=postgres://user:pass@localhost:5432/sunuecole
    export JWT_SECRET=une-longue-chaine-aleatoire
    npm install && npm start            # http://localhost:3000
    npm test                            # (base de test locale : elle est vidée !)
    DEMO_PASSWORD=... node seed.js      # école "demo" facultative

## À prévoir ensuite
Sauvegardes (Render propose des sauvegardes sur les bases payantes), envoi d'e-mails pour « mot de passe oublié » (aujourd'hui : le Directeur réinitialise ses utilisateurs, KMS réinitialise les Directeurs), import des élèves depuis SunuÉcole hors-ligne, paiement Wave par API.
