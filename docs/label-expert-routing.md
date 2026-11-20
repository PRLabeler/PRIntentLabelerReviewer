# Correspondances labels GitHub / experts — étapes 1 à 6

## Règles actuelles après simplification de l'interface

La configuration n'expose plus de choix hérité ni de réglage global au dépôt.
Chaque label propose seulement Aucun expert, Expert Général et les experts
spécialisés. Les boutons de configuration LLM et le sélecteur de dépôt à
navigation automatique restent sur la même page.

Tout label sans correspondance enregistrée affiche Général, y compris les
noms `bug` ou `enhancement` : aucune association spécialisée n'est proposée par
heuristique. Les choix explicites existants sont conservés par identifiant.
Ouvrir la page n'effectue aucune écriture.

Lors d'une sauvegarde, les choix soumis sont enregistrés, les correspondances
omises sont conservées et les nouveaux labels du catalogue courant reçoivent
Général. Aucun reste une association explicite qui désactive la revue pour son
label. Les règles des labels supprimés sont conservées mais restent inactives ;
elles ne sont pas transférées à un label recréé avec le même nom.

Avec une politique enregistrée, même vide, les labels suggérés sans règle
déclenchent Général. Les associations explicites gardent leur priorité, puis la
confiance départage les experts ; un seul est exécuté. Sans politique, le mode
historique reste conservé jusqu'à une sauvegarde. Une erreur de stockage ne
devient jamais une politique absente.

Le champ `defaultBehavior` et la colonne `default_behavior` restent lisibles pour
la compatibilité avec les données et audits historiques. Ils n'influencent plus
le routage ; le service écrit toujours `general` lors d'une sauvegarde explicite.
Aucune migration ni réécriture automatique des données n'est nécessaire.

Les sections suivantes retracent les étapes initiales ; ces règles remplacent
leurs anciennes options de défaut du dépôt et leurs propositions par nom.

L'étape 1 définit les contrats et la résolution du routage. L'étape 2 ajoute la
lecture des dépôts et labels GitHub. L'étape 3 ajoute leur persistance PostgreSQL.
L'étape 5 expose la configuration des correspondances dans les paramètres.
L'étape 6 branche le nouveau routage au handler des PR. Le classifieur, les seuils,
les modes d'application des labels, les commentaires signés et les configurations
LLM conservent leur fonctionnement actuel. L'étape 4 enregistre l'expert Général
dans le moteur existant ; son déclenchement dépend de la politique du dépôt.

## Entrées

`buildExpertRoutingPlan` reçoit :

- la portée `(installationId, repositoryId)` ;
- une politique de cette portée, ou `null` après une lecture réussie sans
  configuration ;
- le catalogue courant des labels GitHub, avec leurs identifiants et noms ;
- les suggestions déjà validées et triées par la politique de labels existante ;
- les identifiants disponibles dans le registre des experts, fournis par
  l'appelant afin de ne pas dupliquer la taxonomie.

La fonction ne lit pas de stockage et ne déclenche aucun expert. Une erreur
du lecteur de politiques doit être propagée par l'appelant, jamais
transformée en `null`. Une politique d'une autre portée, des règles dupliquées
ou un expert non disponible sont rejetés sans repli vers un autre expert.

## Règles d'une politique enregistrée

Le défaut initial est `none`. Le défaut peut seulement être `none` ou `general`.
Chaque règle référence l'identifiant GitHub d'un label et une cible :

- `{ kind: "expert", expertId }` : association explicite ;
- `{ kind: "none" }` : aucun expert pour ce label, même avec le défaut Général ;
- aucune règle : utiliser le défaut du dépôt.

Un choix Aucun est limité au label concerné, pas à toute la PR. Une politique
vide est une configuration à part entière : elle ne réactive pas le routage
historique. Sans suggestion exploitable, aucun expert n'est sélectionné.

Les suggestions sont retrouvées dans le catalogue courant par leur nom,
sans distinction de casse ; les règles sont ensuite retrouvées uniquement par
identifiant. Un renommage conserve donc la règle. Un label supprimé n'est plus
éligible ; un label recréé avec le même nom et un nouvel identifiant utilise le
défaut, sans hériter de l'ancienne association.

## Classement et résultat

Les labels visant un même expert sont regroupés dans un candidat. Chaque
déclencheur conserve son nom, identifiant, confiance, justification et origine
(`explicit`, `default` ou `legacy`). Les confiances ne sont jamais additionnées.

Pour une politique enregistrée, les candidats sont classés par :

1. origine explicite avant origine par défaut ;
2. confiance maximale des déclencheurs de cette origine prioritaire ;
3. identifiant d'expert croissant en cas d'égalité, sans dépendance à la locale.

Si Général reçoit à la fois des associations explicites et des labels utilisant
le défaut, tous les déclencheurs restent visibles. Seules les associations
explicites déterminent sa confiance de classement : un label par défaut ne
doit pas le faire passer devant un autre expert explicitement associé.

Le plan retourne les candidats et `selectedExpert`, le premier candidat ou
`null`. La V1 exécute uniquement `selectedExpert` ; la liste des candidats
prépare une future orchestration multiple sans l'activer.

## Compatibilité historique

Sans politique (`null`), le nom du label est comparé aux identifiants d'experts
disponibles, après passage en minuscules. Le premier expert reconnu dans
l'ordre des suggestions validées est conservé, y compris lors d'une égalité.
Ce comportement est comparé au sélecteur historique dans les tests.

## Lecture GitHub — étape 2

`InstallationRepositoryReader` reçoit une fonction d'authentification compatible
avec `app.auth`. Il est prêt à être injecté dans les futures routes des paramètres,
sans créer de route ni modifier l'interface à cette étape.

- `listRepositories(installationId)` liste les dépôts accessibles à l'installation.
- `readRepositoryLabels(installationId, repositoryId)` retrouve le dépôt dans
  cette liste puis charge ses labels. Un dépôt absent est refusé avant tout
  appel de lecture de labels. L'autorisation de l'utilisateur connecté restera
  à la charge de la couche HTTP.

La pagination Octokit existante est utilisée pour les dépôts et pour les labels.
Le helper accepte aussi l'enveloppe `{ repositories: [...] }` pour les clients
minimaux de tests ; son repli sans `paginate` ne lit qu'une page, comme auparavant.
Les erreurs d'authentification et de lecture, y compris sur une page ultérieure,
sont propagées avec leurs informations GitHub. Elles ne deviennent jamais des
listes vides ou des résultats partiels réussis.

Les deux lecteurs de PR conservent maintenant `repositoryId` et un
`repositoryLabelCatalog` contenant `id`, `name` et `description`. Le lecteur par
API utilise le dépôt de base de la PR, pas celui d'un éventuel fork source.
Ces champs restent optionnels dans `PullRequestData` pour les producteurs
historiques et synthétiques ; les réponses GitHub complètes les renseignent.

Les tableaux de noms et descriptions destinés au classifieur sont conservés.
Les nouvelles métadonnées ne sont pas ajoutées à `PullRequestLlmContext` ni au
prompt. Le catalogue de routage exclut les variantes `🤖 <nom>` comme le
classifieur et conserve les descriptions brutes, ou `null` si elles sont absentes.

## Persistance PostgreSQL — étape 3

La migration additive `003_repository_review_policies.sql` ajoute :

- `repository_review_policies`, par installation et dépôt, avec défaut `none`
  ou `general`, dates et auteurs éventuellement absents ;
- `label_expert_mappings`, par identifiant de label, avec son dernier nom connu ;
  `expert_id IS NULL` représente Aucun explicite, tandis qu'une ligne absente
  utilise le défaut ;
- `repository_review_policy_audits`, contenant l'action, l'auteur et les états
  complets avant/après. Les audits sont conservés après désinstallation.

Les correspondances dépendent de leur politique par une clé étrangère composite
avec suppression en cascade. Aucune relation ne dépend des configurations LLM.
Les migrations 001 et 002 restent inchangées. L'ajout du fichier au registre des
migrations ne l'applique pas automatiquement à une base existante.

`RepositoryRoutingService.getPolicy(scope)` retourne la politique complète ou
`null` uniquement après une lecture réussie sans configuration. Une politique
enregistrée avec zéro règle reste distincte de `null`. Les erreurs de stockage
et d'initialisation lèvent `RepositoryRoutingUnavailableError`, sans détails SQL
et sans repli vers le routage historique.

`save({ installationId, repositoryId, defaultBehavior, mappings, catalog,
githubUserId? })` reçoit le catalogue GitHub de l'étape 2 et remplace l'ensemble
des règles. Un label omis de cette sauvegarde utilise désormais le défaut.
Les identifiants, doublons, experts et portée du catalogue sont validés ; la
future couche HTTP restera responsable de l'autorisation utilisateur/installation.

Le dernier nom connu est actualisé lors d'une sauvegarde si le label est présent
dans le catalogue courant. Une règle orpheline déjà enregistrée peut être
conservée avec son dernier nom connu ; elle n'est pas appliquée par le résolveur
si son identifiant n'existe plus dans le catalogue. Un label recréé avec le même
nom n'hérite jamais de cette règle. Un nouvel identifiant absent du catalogue
et de la politique enregistrée est refusé. Aucune lecture ne synchronise ni ne
supprime implicitement les règles, et aucun webhook de labels n'est ajouté.

Chaque sauvegarde et son audit sont transactionnels. Le repository verrouille
la politique avant de remplacer ses règles et de lire l'état précédent. Les
lectures récupèrent politique et correspondances dans un seul snapshot SQL.
Les sauvegardes complètes concurrentes sont sérialisées ; la dernière sauvegarde
l'emporte, sans fusion ni détection d'un formulaire périmé à ce stade.

Le runtime utilise le pool existant, sans clé de chiffrement ni appel LLM.
L'identifiant `general`, réservé à l'étape 3, est désormais validé depuis le
registre comme les autres experts. La désinstallation tente le nettoyage du routage indépendamment des
autres services : les politiques ciblées et leurs règles sont supprimées dans
une transaction, avec audits et auteur du webhook lorsqu'il est disponible.

Les tests du repository utilisent un client PostgreSQL simulé, conformément aux
tests existants. Ils vérifient les paramètres, transactions, verrous, audits et
rollbacks ; ils ne remplacent pas une exécution de la migration sur PostgreSQL.

## Expert Général — étape 4

Le registre contient maintenant `general`, affiché sous le nom « Général ». Sa
politique cherche des erreurs de logique, régressions, cas limites, défauts de
fiabilité et problèmes de sécurité concrets. Chaque constat doit être étayé par
le diff ; les suggestions stylistiques et spéculatives sont exclues. Le prompt
ne suppose pas une intention particulière pour cette revue générale.

Les définitions, liens et routes existants exposent sa configuration à
`/settings/:installationId/experts/general`. Général réutilise le service de
configuration des experts, le chiffrement, le repository PostgreSQL, la factory,
le moteur `ConfigurableReviewExpert` et la publication inline. Aucune table ni
migration supplémentaire n'est nécessaire.

Comme pour les autres experts, les fournisseurs autorisés sont Anthropic,
OpenAI et Gemini. La configuration enregistrée pour `(installationId, general)`
est prioritaire. À défaut de configuration, le mécanisme Gemini du serveur est
conservé ; sans clé disponible, aucune revue n'est exécutée. Une erreur de
configuration n'autorise aucun repli silencieux.

Les modèles par défaut restent inchangés : le formulaire utilise la définition
du fournisseur sélectionné ; le repli d'exécution utilise `GEMINI_REVIEW_MODEL`
ou sa valeur par défaut existante. Aucun réglage LLM enregistré n'est modifié.

Les contrats et la persistance acceptent Général comme cible explicite ou comme
défaut. Sans politique enregistrée, le routage historique peut reconnaître un
label nommé exactement `general`, comme tout identifiant d'expert enregistré ;
les autres labels ne déclenchent pas Général automatiquement.

Les tests paramétrés existants parcourent le registre et vérifient donc aussi
Général : fournisseurs, chiffrement, isolation, formulaires, routes, budgets et
revue. Les vérifications dédiées portent sur sa politique, le repli Gemini et
la publication inline sans doublon.

## Interface de configuration — étape 5

`/settings/:installationId` contient deux sections principales : le classifieur
et les experts IA. La seconde affiche directement un tableau « Label GitHub →
Expert IA », avec un sélecteur compact de dépôt. Le premier dépôt accessible est
sélectionné par défaut ; le paramètre `repositoryId` permet d'en choisir un autre
sur la même page. Aucun parcours séparé n'est nécessaire.

Les configurations LLM des experts restent accessibles par des liens discrets
dans cette même section. Le défaut du dépôt est configurable dans un détail
repliable. Le choix « Défaut du dépôt » reste distinct d'un « Aucun expert »
explicite ; l'interface ne transforme pas les correspondances absentes en refus.

La sauvegarde utilise toujours le POST existant
`/settings/:installationId/repositories/:repositoryId/routing/save`, puis revient
sur la page principale et le dépôt sélectionné. Les anciens liens vers les
correspondances restent compatibles : la liste redirige vers la section des
experts, et l'ancienne URL d'un dépôt affiche la même page unifiée.

Le lecteur de l'étape 2 est injecté à l'enregistrement des routes via `app.auth`.
Les nouvelles routes réutilisent la session OAuth et le contrôle des installations
autorisées. Le lecteur vérifie l'appartenance du dépôt avant toute lecture de
politique ou sauvegarde. Les écritures vérifient également le jeton CSRF. Comme
les paramètres existants, les droits utilisateur sont définis au niveau de
l'installation ; aucune nouvelle gestion de permissions individuelles par dépôt
n'est introduite.

La page utilise les noms et descriptions actuels de GitHub, échappés en HTML.
Chaque label propose le défaut, Aucun explicite, Général et les experts du
registre. Le défaut initial du dépôt reste Aucun. En l'absence de politique, les
noms correspondant exactement à un expert et l'alias `enhancement` vers Feature
reçoivent une proposition modifiable, non enregistrée. Une politique existante,
même vide, désactive ces propositions, y compris pour les nouveaux labels.

Les règles de labels supprimés restent affichées comme inactives, avec leur
dernier nom connu. Choisir le défaut permet de retirer une telle règle lors de
la sauvegarde. Un label recréé avec le même nom apparaît comme un label distinct.
Les noms sont actualisés uniquement lors d'une sauvegarde ; ouvrir la page ne
modifie ni les règles ni les métadonnées en base.

Avant un POST, le catalogue et la politique sont relus. Un renommage conserve
l'association par identifiant. Un nouveau label non présent dans le formulaire
utilise le défaut. Un label supprimé depuis l'ouverture du formulaire et qui ne
possède pas de règle enregistrée provoque un refus 409 avec les valeurs actuelles,
sans sauvegarde partielle. Les formulaires incomplets, cibles inconnues et champs
répétés sont rejetés.

Un témoin fondé sur `updatedAt` détecte les modifications de politique intervenues
depuis l'ouverture de la page. Ce contrôle précède la sauvegarde : ce n'est pas
un verrou optimiste transactionnel. Les écritures réellement simultanées restent
soumises à la règle de remplacement complet de l'étape 3 (dernière sauvegarde
validée prioritaire).

Les erreurs GitHub et de stockage sont affichées sans détails bruts ni secrets.
Si une sauvegarde échoue, les choix valides sont conservés dans le formulaire.
Le POST dispose d'un parseur limité à 256 Ko et 10 000 paramètres pour les grands
catalogues ; les formulaires LLM conservent leur limite de 16 Ko. Aucun script
supplémentaire, appel LLM, migration ou modification du workflow des PR n'est ajouté.

La migration 003 doit avoir été appliquée par l'exploitant pour lire et sauvegarder
les politiques. L'interface n'applique aucune migration automatiquement.

### Diagnostic d'un HTTP 503

Le service reconnaît le code PostgreSQL `42P01` (relation absente) et remonte
`RepositoryRoutingSchemaMissingError`. L'interface indique alors explicitement
que le schéma des correspondances est absent ou incomplet et que la migration
003 est requise. Elle ne remplace pas cette erreur par une politique vide ou
des propositions initiales. Les labels restent consultables en lecture seule
et les paramètres du classifieur restent affichés.

La présence des tables peut être vérifiée sans modification avec :

```sql
SELECT to_regclass('repository_review_policies'),
       to_regclass('label_expert_mappings'),
       to_regclass('repository_review_policy_audits');
```

Une valeur `NULL` indique une table absente du chemin de recherche courant.
Si les tables manquent, exécuter le script de migration existant
`npm run db:migrate` sur le serveur et la base concernés. Les autres erreurs
de stockage restent distinctes de ce diagnostic, sans exposer de secrets SQL.

## Intégration au workflow des PR — étape 6

Après la classification et la validation des suggestions, `handlePullRequestEvent`
lit la politique PostgreSQL de `(installationId, repositoryId)` avec
`RepositoryRoutingService.getPolicy`. Il transmet cette politique, le catalogue
GitHub courant et les suggestions validées à `buildExpertRoutingPlan`. La liste
des experts provient du registre existant. Aucune politique n'est créée ou
modifiée pendant une revue.

Le handler exécute seulement `selectedExpert`. Les associations explicites sont
prioritaires sur le défaut Général, puis la confiance départage les experts
selon les règles du résolveur. Les suggestions rejetées par le classifieur et
les variantes de labels préfixées par le bot ne deviennent pas des déclencheurs.
Le choix reste indépendant du mode d'application des labels, y compris `suggest`.
Sans suggestion validée, aucune lecture de politique ni revue n'est nécessaire.

Seul un résultat `null` après lecture réussie conserve le routage historique.
Une politique vide ne provoque aucun repli ; Aucun explicite bloque seulement
le label concerné, même si le défaut est Général. Un catalogue ou une portée
manquants, une politique invalide ou une panne de stockage suspendent la revue,
sans empêcher l'analyse, les opérations de labels ou la publication de la Check
Run. Le commentaire d'analyse et les logs indiquent l'échec sans détails SQL.
Le diagnostic d'une migration 003 absente reste explicite. Un serveur sans
PostgreSQL disponible ne peut donc pas supposer l'absence de politique.

L'expert retenu passe par `resolveReviewExpert` : sa configuration LLM enregistrée
est utilisée, ou le repli Gemini existant uniquement si aucune configuration
n'existe. Une erreur de configuration n'essaie ni Gemini ni un autre candidat.
Les constats sont publiés par `publishIntentReview`, avec les mêmes ancrages,
SHA et protections contre les doublons qu'auparavant.

Les logs indiquent la portée, le mode de routage, les labels déclencheurs avec
leurs identifiants, confiance et origine, ainsi que l'expert retenu. Le log de
configuration ajoute le fournisseur, le modèle effectifs et leur source
(`installation` ou `environment`), sans configuration complète ni clé API.
Un choix sans expert est journalisé avec `expertId: null`.

Les tests du handler réutilisent le résolveur, le service de routage et le moteur
de revue réels. Le stockage et les appels HTTP sont simulés. Ils couvrent les
alias et renommages, le choix unique, le défaut Général, Aucun explicite, une
politique vide, les erreurs de stockage et la publication inline. Les règles
détaillées du classement restent couvertes par les tests existants du résolveur.

La migration 003 reste un prérequis d'exploitation ; cette étape ne l'exécute
pas automatiquement. La suite du plan reste soumise à validation.
