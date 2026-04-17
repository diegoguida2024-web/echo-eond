# Railway Setup Guide

## Errore: Variabili di Ambiente Non Configurate

Se vedi questo errore su Railway:
```
❌ MISSING ENVIRONMENT VARIABLES:
   - DISCORD_TOKEN
   - DISCORD_CLIENT_ID
   - DISCORD_GUILD_ID
```

## Soluzione: Configurare le Variabili in Railway

### Passo 1: Vai su Railway Dashboard
1. Accedi a [railway.app](https://railway.app)
2. Seleziona il tuo progetto
3. Clicca su **"Variables"** (o **"Settings"** → **"Variables"**)

### Passo 2: Aggiungi le Variabili

Copia e incolla queste variabili da un terminale:

```bash
# Nel tuo terminale locale:
cat .env
```

Quindi in Railway Dashboard, aggiungi:

| Variable Name | Value |
|---|---|
| `DISCORD_TOKEN` | (copia da `.env` locale) |
| `DISCORD_CLIENT_ID` | `1494813277295870053` |
| `DISCORD_GUILD_ID` | `1494784027415281795` |
| `CHANNEL_TASK_BOARD` | `1494799579286339724` |
| `CHANNEL_BUG_TRACKER` | `1494797434755350538` |
| `CHANNEL_DEV_REQUESTS` | `1494798966057992283` |
| `CHANNEL_LOG` | `1494797142869414010` |
| `ROLE_EXECUTIVE` | `1494804055980245115` |
| `ROLE_OPS` | `1494804370657906879` |

### Passo 3: Salva e Rideploy

1. Clicca **Save**
2. Railway automaticamente farà un nuovo deploy
3. Aspetta che il deploy finisca
4. Verifica i log per confermare che il bot è online

## Se il Bot Non Si Connette

Verifica che:
- ✅ Token è corretto (inizia con `MTQ...`)
- ✅ Client ID è numerico
- ✅ Guild ID è numerico
- ✅ Il bot ha i permessi sul server Discord

Se ancora non funziona, controlla i **logs su Railway** per il messaggio di errore preciso.
