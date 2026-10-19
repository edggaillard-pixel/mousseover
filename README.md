# MousseOver

Jeu multijoueur dans le navigateur (2 à 5 joueurs) : garde ta souris dans le cercle qui rétrécit toutes les 10 secondes, évite les lasers et, à partir du 3e rétrécissement, les bombes qui apparaissent sous ta souris.

## Comment ça marche
 
- Site 100 % statique : `index.html`, `style.css`, `game.js`.
- Le multijoueur passe par [PeerJS](https://peerjs.com/) (WebRTC). Les navigateurs se parlent directement ; le serveur gratuit de PeerJS sert seulement à les mettre en relation. Pas besoin d'un serveur à soi.
- Le créateur du salon est l'**hôte** : son navigateur fait tourner la partie et décide qui meurt. Il doit garder l'onglet du jeu au premier plan.
- Un seul onglet du jeu par navigateur.

## Mettre en ligne sur GitHub Pages

1. Crée un dépôt public, par exemple `mousseover`.
2. Mets-y les fichiers `index.html`, `style.css`, `game.js` (à la racine).
3. Dans le dépôt : **Settings → Pages → Build and deployment**, source **Deploy from a branch**, branche `main`, dossier `/ (root)`, puis **Save**.
4. Après une minute environ, le jeu est en ligne sur `https://<ton-pseudo>.github.io/mousseover/`.

## Tester

- **Tester seul** : lance une partie solo directement (pratique pour régler la difficulté).
- **Multijoueur** : il faut deux navigateurs différents ou deux ordinateurs (deux onglets du même navigateur sont bloqués exprès).

## Régler la difficulté

Tous les réglages sont en haut de `game.js`, dans l'objet `CFG` (vitesse de rétrécissement, fréquence des lasers, rayon des bombes, etc.).
