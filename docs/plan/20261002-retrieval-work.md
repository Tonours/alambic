# Implemented: indexation CRLF et graphe sans lectures redondantes

## Metadata
- Archived: 2026-10-02
- Source plan: `PLAN.md` — Improve local retrieval correctness and eliminate repeated index/graph work.
- Source plan SHA-256: `495c18944d86d6d6ed9b88b9bbb9d79880e4db60eaa60aec334707d19176d66b`
- Status: IMPLEMENTED
- Commit / branch: `main`, base `55dfbb571cecf999dddb95a6de64107dd742cefd`; changements locaux non commités.
- Workflow initiative: `retrieval-work-20261002`
- Tier: standard
- Result: verified sur le moteur local et les scénarios décrits ci-dessous.

## Outcome

- Les notes avec des fins de ligne Windows (CRLF) conservent leur type, statut, résumé, tags et alias. Le parseur existant reçoit le texte déjà lu ; les octets bruts et leur SHA restent ceux du fichier.
- Les anciens caches lexicaux v2 et graphes v1.2.0 sont reconstruits automatiquement. Cette migration corrige aussi les notes CRLF déjà indexées, sans demander une modification de leur contenu.
- Le graphe utilise un seul manifest frais, complet avant exclusion des index, et son texte brut. Son empreinte, ses métadonnées et ses liens décrivent le même instantané.
- Une table de noms normalisés remplace le parcours linéaire des alias. Les priorités exacte, lowercase, puis premier nom normalisé restent identiques, y compris lors des collisions.
- Les tests ajoutés couvrent LF/CRLF, migration de caches, citations et budget de session, lectures/statistiques de fichiers, collisions d’alias et invalidation immédiate après ajout, modification ou suppression.

## Context and sources

L’audit a commencé par l’état Git propre, les huit derniers commits, `AGENTS.md`, `CLAUDE.md`, les connaissances récupérées avec Alambic, la carte des modules et la suite existante. L’audit du 28 septembre avait déjà corrigé plusieurs parcours d’installation, de promotion et de nightly ; ce travail a sélectionné la récupération locale, avec des gains mesurables et un défaut reproductible.

- `_meta/lib/vault.mjs:74-84` : lecture du fichier suivie d’une seconde lecture dans `parseMarkdown(file)` ; reconnaissance de l’ouverture du frontmatter limitée à LF.
- `_meta/lib/frontmatter.mjs:17-45` : `parseMarkdownText` accepte déjà LF et CRLF.
- `_meta/lib/graph-builder.mjs:39-99` : le manifest complet et le texte capturé peuvent fournir l’empreinte et les liens sans deuxième scan ni lecture.
- `_meta/tests/lexical-cache.mjs`, `graph.mjs`, `retrieval-io.mjs` : cas de non-régression exécutables.
- `docs/plan/20260928-alambic-audit-hardening.md` : corrections antérieures et limites déjà connues.

Les parcours attention, installation, harvest, promotion et publication ont été cartographiés ; leur logique métier n’a pas fait l’objet d’une nouvelle revue exhaustive dans cette tranche.

## Decisions

### Conserver un instantané cohérent

Le texte capturé sert à la fois au parseur, au hash et aux liens du graphe. La vérification des fichiers reste `fresh: true` pour chaque demande de graphe. Les index contribuent toujours à l’empreinte, tout en restant exclus des nœuds.

### Migrer les caches avec la correction du parseur

Les octets CRLF ne changent pas lorsqu’on corrige le code. Leur empreinte ne suffisait donc pas à invalider les mauvaises métadonnées persistées. Les versions des deux caches ont été augmentées ; un test réinjecte les anciennes versions avec taille et mtime inchangées.

### Préserver les collisions de noms

La table normalisée est créée après la table exacte, dans son ordre final. Cela conserve les valeurs écrasées par un basename ultérieur, la première entrée normalisée et la priorité d’un nom lowercase exact.

## Accepted Drift

- La comparaison du graphe ignore `generated_at` et sa version de cache volontairement augmentée ; `snapshot`, `stats`, `nodes`, `edges` et `claims` restent identiques sur le corpus LF.
- Un graphe reconstruit utilise désormais le texte du manifest, y compris son angle mort taille/mtime. Les nœuds et l’empreinte suivaient déjà cet instantané ; les liens suivent maintenant la même source. Ce choix a été accepté par les revues contradictoires.

## Measured performance

Evidence: `baseline-benchmark.json`, `treatment-benchmark.json` et le script figé `measure.mjs`, conservés sous `.workflow/retrieval-work-20261002/evidence/`.

Mesure locale sur Node v25.9.0 : 500 notes LF liées par des alias, cinq répétitions par scénario, clé TypeSafe désactivée. Les temps sont des médianes observées ; les nombres de lectures et de stats sont les critères déterministes.

| Scénario | Avant | Après | Travail sur les fichiers |
| --- | ---: | ---: | --- |
| Manifest sans cache lexical | 14,217 ms | 11,434 ms | 1 000 → 500 lectures Markdown |
| Reconstruction du graphe, manifest en mémoire | 17,905 ms | 7,037 ms | 500 → 0 lectures ; 1 000 → 500 stats ; 4 → 2 lectures de répertoires |
| Graphe déjà en cache | 2,400 ms | 2,403 ms | 0 lecture Markdown ; 500 stats conservées |
| Commande CLI `session` | 73,615 ms | 74,781 ms | Gain de latence non démontré |

La reconstruction mesurée du graphe prend 60,7 % de temps en moins sur ce corpus. Cette mesure couvre le traitement local de cette fixture ; elle ne mesure ni un provider réel ni la qualité globale de mémoire d’un agent.

Les trois empreintes de sortie LF sont identiques avant/après :

- Manifest : `ba6fdcf81170b0f7085c4765599a15d78512b9c1de943040d01f6f91dadd461e`
- Graphe normalisé : `deccfe88c2e086f6cb3cce17dfd1f468c331de745dfa3715dbe0601702c02439`
- Session CLI : `abd0f26f43623f4a0c84c645816be2f38caaa57476f6a90d70a47803b852f498`

Reproduction de la mesure dans un répertoire temporaire :
```bash
node .workflow/retrieval-work-20261002/evidence/measure.mjs . /tmp/alambic-retrieval-replay replay
```

## Validation Evidence

- command: `npm test`
  - result: passed avant modification (41,35 s) et après implémentation (45,59 s), logs `baseline-tests.log` et `final-tests.log`.
- command: `node _meta/tests/lexical-cache.mjs .`
  - result: failed avant correction sur le type CRLF (`source` au lieu de `reference`) ; passed après correction et après simplification, avec les caches hérités et la session CLI réelle.
- command: `node _meta/tests/retrieval-io.mjs .`
  - result: failed avant correction (25 lectures pour 13 fichiers) ; passed ensuite sur les états froid, mémoire, disque et graphe en cache.
- command: `node _meta/tests/graph.mjs .`
  - result: passed, dont les six résolutions ambiguës et les changements immédiats de contenu/graphe.
- command: `_meta/validate-kb.sh`
  - result: passed, validation stricte de 22 notes.
- command: `_meta/alambic lint --check`
  - result: passed, 0 erreur structurelle, 0 claim invalide, 0 conflit sémantique. Indications conservées : 1 orphelin, 1 note stale/superseded et 1 dépendance de graphe stale.
- command: comparaison SHA-256 des entrées canoniques
  - result: passed, les 38 fichiers de `kb/`, `ref/` et des évaluations figées sont inchangés.
- command: `git diff --check` et `plan-check-freeze`
  - result: passed ; critères et vérifications READY conservés.
- Simplification: `simplify: removed 2`, suppression de l’import et de l’appel d’invalidation inutiles dans le test.
- Quality: pass, comparaison du diff avec `frontmatter.mjs`, `graph-router.mjs` et `graph-traversal.mjs` ; aucune nouvelle dépendance ou interface publique.

## Independent review

- Plan : Claude Opus 5.5, provider effectif `firstParty`, P1 CHALLENGED puis P2 READY. Corrections acceptées : migration des deux caches, empreinte du manifest non filtré, ordre final de la table d’alias et renforcement des tests.
- T1 et F1 : Logic et Spec dans des contextes Codex isolés, modèle OpenAI hérité (identifiant exact non exposé). Deux verdicts lead GO ; tableaux deciding-code complets, cinq comportements et huit axes couverts.
- Adversaire du code T1 et F1 : Claude Opus 5.5, modèle et provider vérifiés dans `modelUsage`, deux GO sans constat accepté.
- Base : `55dfbb571cecf999dddb95a6de64107dd742cefd`.
- Patch complet vérifié : `94c21eab979d4badbcc1246dd824b465f1907494f2b6b1cbfb8f5a8f6ff12a9c`.
- Sessions finales : plan `e6821d42-e711-468f-9641-1cab91821b62` ; code T1 `8f216c9d-219c-4594-aa63-857b8cf7e094` ; code F1 `f881b2ea-6b28-4b79-899e-f39f7cd6abb3`.
- Reports: `T1-logic.md`, `T1-spec.md`, `T1-lead.md`, `T1-adversary.json`, puis les fichiers `F1-*` dans le répertoire d’evidence.

## Follow-up State

- Remaining risks: le cache fondé sur taille/mtime peut conserver une ancienne entrée après une restauration qui préserve les deux valeurs. Le commentaire existant dans `vault.mjs:181-185` donne la reconstruction en supprimant le cache dérivé comme sortie de ce cas. Le scénario de synchronisation préservant les métadonnées n’a pas été durci ici.
- Parking lot — propositions à cadrer séparément :
  - `vault.mjs` compte 1 556 lignes et réunit manifest/cache, validation, scoring, context et lint. Un découpage par responsabilités pourrait réduire le couplage, avec conservation des APIs et des sorties figées comme critères ; aucun bénéfice runtime n’est encore mesuré.
  - `alambic.mjs` compte 748 lignes, `setup.mjs` 917. La récupération et attention sont déjà séparées ; une prochaine extraction devrait viser une responsabilité concrète et un parcours couvert.
  - Profiler le démarrage CLI avant de proposer une nouvelle optimisation de `session` : ses cinq mesures ne montrent pas de gain. Le chargement du SDK TypeSafe est déjà différé ; cette optimisation existe.
  - Une synchronisation préservant taille/mtime justifierait un plan de cache distinct avec reproduction, seuil de coût et politique de fraîcheur explicites.
- Superseded docs/specs: none.
- Next action: les changements sont prêts pour inspection et commit local à la demande de l’utilisateur ; les propositions différées ne sont pas des corrections acceptées en attente.
