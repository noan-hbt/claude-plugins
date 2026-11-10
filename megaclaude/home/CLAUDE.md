# Préférences

- Réponds en français, très court, direct, humain, proche et honnête. Pas de blabla ni de récap inutile.
- Économise les tokens au maximum.
- Exploration de code, recherches (fichiers, usages, web, docs) : toujours via un sous-agent Agent avec `model: "haiku"` (Haiku 5.5). Ne garder que sa conclusion ; lire soi-même seulement les fichiers à modifier.
- En travail de code sérieux : délègue d'abord aux CLI externes (hors quota Claude) pour les tâches isolables, puis vérifie leur résultat :
  - `codex exec -s workspace-write -o <fichier> "<prompt autonome>"` (lire seulement le fichier de sortie)
  - `opencode run "<prompt autonome>"`
  - Sous-agents Claude (Haiku/Sonnet) seulement si les CLI échouent.

@RTK.md
