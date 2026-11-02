# claude-plugins

Mes réglages et extensions pour Claude Code.

## Barre d'état d'usage

Affiche l'usage en permanence, sans avoir à taper `/usage` :

```
[CAVEMAN] Opus 5.5 · ctx 62% · 5h 12% · 7d 85% · 5k out · ~$0.46 · top: /code-review
```

| Élément | Sens | Source |
|---|---|---|
| `[CAVEMAN]` | mode caveman actif | plugin `caveman` |
| `ctx` | contexte utilisé | Claude Code |
| `5h` / `7d` | limites du plan (vert, jaune dès 50 %, rouge dès 80 %) | Claude Code |
| `5k out` | tokens de sortie de la session | plugin `token-usage` |
| `~$0.46` | coût API estimé, pas la facture d'un abonnement | plugin `token-usage` |
| `top:` | commande la plus coûteuse | plugin `token-usage` |

Une partie sans données est masquée, donc les deux plugins sont facultatifs. Les données de
`token-usage` se rafraîchissent à la fin de chaque tour ou sous-agent.

### Installation (Windows PowerShell 5.1)

Copier le script :

```powershell
Copy-Item statusline\statusline.ps1 "$HOME\.claude\statusline.ps1"
```

Puis dans `~/.claude/settings.json`, en remplaçant `<utilisateur>` :

```json
{
  "statusLine": {
    "type": "command",
    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<utilisateur>\\.claude\\statusline.ps1\""
  }
}
```
